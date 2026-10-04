grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.games
  add column is_production_canary boolean default false;

alter table app_private.lists
  add column is_production_canary boolean default false,
  add column production_canary_generation uuid;

create table app_private.production_product_canaries (
  id uuid primary key,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  generation uuid not null,
  phase text not null check (phase in ('active', 'request_pending', 'cleanup_pending', 'recovery_required')),
  command_id uuid,
  operation text check (operation in (
    'note.create', 'note.update', 'note.remove', 'note.restore',
    'list.create', 'relation.add', 'game.trash', 'game.restore'
  )),
  target_ids uuid[] not null default '{}',
  deadline_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint production_product_canaries_fixed_id
    check (id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid),
  constraint production_product_canaries_pending_shape
    check ((phase in ('request_pending', 'recovery_required')) = (command_id is not null and operation is not null and deadline_at is not null)),
  constraint production_product_canaries_generation_unique unique (generation)
);

alter table app_private.production_product_canaries enable row level security;
alter table app_private.production_product_canaries force row level security;
create policy migrator_production_product_canaries_all
  on app_private.production_product_canaries for all to app_migrator using (true) with check (true);
revoke all on app_private.production_product_canaries from public, anon, authenticated, service_role, app_runtime;

create function app_private.claim_production_product_canary(uuid, text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  requested_owner alias for $2;
begin
  if requested_generation is null or requested_owner is null or length(btrim(requested_owner)) = 0 then
    raise exception 'canary identity is invalid';
  end if;
  insert into app_private.production_product_canaries(id, owner_id, generation, phase)
  values ('adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid, requested_owner, requested_generation, 'active');
  perform set_config('app.production_canary_setup_generation', requested_generation::text, true);
  insert into app_private.games(id, medium, display_name, is_production_canary)
  values
    ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'board_game', '正式 canary 桌遊', true),
    ('c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid, 'video_game', '正式 canary 電子遊戲', true);
  return true;
exception when unique_violation then
  return false;
end;
$$;

create function app_private.begin_production_product_canary_command(uuid, text, uuid, text, uuid[])
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  requested_owner alias for $2;
  requested_command alias for $3;
  requested_operation alias for $4;
  requested_targets alias for $5;
begin
  if requested_operation is null or requested_operation not in (
    'note.create', 'note.update', 'note.remove', 'note.restore',
    'list.create', 'relation.add', 'game.trash', 'game.restore'
  ) then raise exception 'canary operation is invalid'; end if;
  if requested_targets is null or cardinality(requested_targets) not between 1 and 2 then
    raise exception 'canary targets are invalid';
  end if;
  if requested_operation in ('game.trash', 'game.restore', 'note.create', 'list.create')
    and (cardinality(requested_targets) <> 1 or requested_targets[1] not in (
      '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid,
      'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
    )) then raise exception 'canary target is not fixed'; end if;
  if requested_operation in ('note.update', 'note.remove', 'note.restore') and not exists (
    select 1 from app_private.notes where id = any(requested_targets)
      and game_id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid)
  ) then raise exception 'canary note target is not fixed'; end if;
  if requested_operation = 'relation.add' and (cardinality(requested_targets) <> 2
    or not ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid = any(requested_targets))
    or not ('c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid = any(requested_targets))) then
    raise exception 'canary relation targets are not fixed';
  end if;
  update app_private.production_product_canaries
  set phase = 'request_pending', command_id = requested_command, operation = requested_operation,
      target_ids = requested_targets,
      deadline_at = clock_timestamp() + interval '30 seconds', updated_at = clock_timestamp()
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and generation = requested_generation and owner_id = requested_owner and phase = 'active';
  return found;
end;
$$;

create function app_private.guard_production_product_canary_command(uuid, text, uuid, text, uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  requested_owner alias for $2;
  requested_command alias for $3;
  requested_operation alias for $4;
  requested_targets alias for $5;
  registered app_private.production_product_canaries%rowtype;
begin
  if requested_generation is null or requested_owner is null or requested_command is null
    or requested_operation is null or requested_targets is null then
    raise exception 'canary_command_rejected' using errcode = 'P0001';
  end if;
  select * into registered
  from app_private.production_product_canaries
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
  for share;
  if not found or registered.generation <> requested_generation
      or registered.owner_id <> requested_owner
      or registered.command_id <> requested_command
      or registered.operation <> requested_operation
      or registered.target_ids <> requested_targets
      or registered.phase <> 'request_pending' then
    raise exception 'canary_command_rejected' using errcode = 'P0001';
  end if;
  if clock_timestamp() >= registered.deadline_at then
    raise exception 'canary_command_expired' using errcode = 'P0001';
  end if;
  perform set_config('app.production_canary_generation', requested_generation::text, true);
  perform set_config('app.production_canary_owner_id', requested_owner, true);
  perform set_config('app.production_canary_command_id', requested_command::text, true);
  perform set_config('app.production_canary_operation', requested_operation, true);
  perform set_config('app.production_canary_target_ids', array_to_string(requested_targets, ','), true);
end;
$$;

create function app_private.guard_current_production_product_canary_command()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
begin
  perform app_private.guard_production_product_canary_command(
    current_setting('app.production_canary_generation', true)::uuid,
    current_setting('app.production_canary_owner_id', true),
    current_setting('app.production_canary_command_id', true)::uuid,
    current_setting('app.production_canary_operation', true),
    string_to_array(current_setting('app.production_canary_target_ids', true), ',')::uuid[]
  );
end;
$$;

create function app_private.assert_production_product_canary_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  canary_game_ids constant uuid[] := array[
    '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid,
    'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
  ];
  operation text := current_setting('app.production_canary_operation', true);
  game_id uuid;
  list_id uuid;
  target_ids uuid[] := string_to_array(current_setting('app.production_canary_target_ids', true), ',')::uuid[];
begin
  if exists (
    select 1 from app_private.production_product_canaries
    where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
      and generation::text = current_setting('app.production_canary_cleanup_generation', true)
      and phase = 'cleanup_pending'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'games' then
    if tg_op = 'INSERT' and new.is_production_canary then
      if current_setting('app.production_canary_setup_generation', true) is distinct from (
        select generation::text from app_private.production_product_canaries
        where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid and phase = 'active'
      ) then raise exception 'canary_fixture_write_denied'; end if;
      return new;
    end if;
    if tg_op = 'DELETE' and old.is_production_canary then
      raise exception 'canary_fixture_write_denied';
    end if;
    if tg_op = 'UPDATE' and (old.is_production_canary or new.is_production_canary) then
      perform app_private.guard_current_production_product_canary_command();
      if old.id <> new.id or old.is_production_canary <> new.is_production_canary
        or old.is_production_canary is not true
        or not (old.id = any(target_ids))
        or old.id <> all(canary_game_ids)
        or (to_jsonb(old) - 'trashed_at' - 'version' - 'updated_at')
          is distinct from (to_jsonb(new) - 'trashed_at' - 'version' - 'updated_at')
        or (operation = 'game.trash' and (old.trashed_at is not null or new.trashed_at is null))
        or (operation = 'game.restore' and (old.trashed_at is null or new.trashed_at is not null))
        or operation not in ('game.trash', 'game.restore') then
        raise exception 'canary_game_write_rejected';
      end if;
    end if;
    return new;
  elsif tg_table_name = 'notes' then
    game_id := case when tg_op = 'DELETE' then old.game_id else new.game_id end;
    if exists (
      select 1 from app_private.games
      where id in (
        case when tg_op = 'INSERT' then new.game_id else old.game_id end,
        case when tg_op = 'DELETE' then old.game_id else new.game_id end
      ) and is_production_canary
    ) then
      perform app_private.guard_current_production_product_canary_command();
      if operation not in ('note.create', 'note.update', 'note.remove', 'note.restore')
        or game_id <> all(canary_game_ids)
        or (tg_op = 'INSERT' and not (game_id = any(target_ids)))
        or (tg_op <> 'INSERT' and not (case when tg_op = 'DELETE' then old.id else new.id end = any(target_ids)))
        or (tg_op = 'UPDATE' and (old.id <> new.id or old.game_id <> new.game_id
          or (operation = 'note.update' and old.removed_at is distinct from new.removed_at)
          or (operation = 'note.remove' and (old.content is distinct from new.content
            or old.removed_at is not null or new.removed_at is null))
          or (operation = 'note.restore' and (old.content is distinct from new.content
            or old.removed_at is null or new.removed_at is not null))))
        or tg_op = 'DELETE' then
        raise exception 'canary_note_write_rejected'; end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  elsif tg_table_name = 'lists' then
    if tg_op = 'INSERT' and operation = 'list.create' then
      perform app_private.guard_current_production_product_canary_command();
      new.is_production_canary := true;
      new.production_canary_generation := current_setting('app.production_canary_generation', true)::uuid;
    elsif tg_op = 'INSERT' and new.is_production_canary then
      raise exception 'canary_list_write_rejected';
    elsif (tg_op = 'UPDATE' and (old.is_production_canary or new.is_production_canary)) then
      raise exception 'canary_list_write_rejected';
    elsif tg_op = 'DELETE' and old.is_production_canary then
      raise exception 'canary_fixture_write_denied';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  elsif tg_table_name = 'list_memberships' then
    game_id := case when tg_op = 'DELETE' then old.game_id else new.game_id end;
    list_id := case when tg_op = 'DELETE' then old.list_id else new.list_id end;
    if exists (select 1 from app_private.games where id = game_id and is_production_canary)
      or exists (select 1 from app_private.lists where id = list_id and is_production_canary) then
      perform app_private.guard_current_production_product_canary_command();
      if operation <> 'list.create'
        or game_id <> all(canary_game_ids)
        or not (game_id = any(target_ids))
        or not exists (select 1 from app_private.lists where id = list_id and is_production_canary
          and production_canary_generation::text = current_setting('app.production_canary_generation', true)) then
        raise exception 'canary_list_member_write_rejected';
      end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  elsif tg_table_name = 'game_relations' then
    if exists (select 1 from app_private.games where id in (
      case when tg_op = 'DELETE' then old.left_game_id else new.left_game_id end,
      case when tg_op = 'DELETE' then old.right_game_id else new.right_game_id end
    ) and is_production_canary) then
      perform app_private.guard_current_production_product_canary_command();
      if operation <> 'relation.add'
        or tg_op <> 'INSERT'
        or new.left_game_id is null or new.right_game_id is null
        or new.left_game_id = new.right_game_id
        or new.left_game_id <> all(canary_game_ids)
        or new.right_game_id <> all(canary_game_ids)
        or not (new.left_game_id = any(target_ids))
        or not (new.right_game_id = any(target_ids)) then raise exception 'canary_relation_write_rejected'; end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger production_product_canary_games_guard
before insert or update or delete on app_private.games
for each row execute function app_private.assert_production_product_canary_write();
create trigger production_product_canary_notes_guard
before insert or update or delete on app_private.notes
for each row execute function app_private.assert_production_product_canary_write();
create trigger production_product_canary_lists_guard
before insert or update or delete on app_private.lists
for each row execute function app_private.assert_production_product_canary_write();
create trigger production_product_canary_memberships_guard
before insert or update or delete on app_private.list_memberships
for each row execute function app_private.assert_production_product_canary_write();
create trigger production_product_canary_relations_guard
before insert or update or delete on app_private.game_relations
for each row execute function app_private.assert_production_product_canary_write();

create function app_private.complete_production_product_canary_command(uuid, uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
  update app_private.production_product_canaries
  set phase = 'active', command_id = null, operation = null, target_ids = '{}', deadline_at = null, updated_at = clock_timestamp()
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and generation = $1 and command_id = $2 and phase = 'request_pending'
  returning true;
$$;

create function app_private.require_production_product_canary_recovery(uuid, uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  marked boolean;
begin
  update app_private.production_product_canaries
  set phase = 'recovery_required', updated_at = clock_timestamp()
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and generation = $1 and command_id = $2 and phase = 'request_pending'
    and deadline_at <= clock_timestamp()
  returning true into marked;
  return coalesce(marked, false);
end;
$$;

create function app_private.prepare_production_product_canary_cleanup(uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  current_phase text;
  pending_deadline timestamptz;
begin
  select phase, deadline_at into current_phase, pending_deadline
  from app_private.production_product_canaries
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and generation = requested_generation
  for update;
  if not found then return false; end if;
  if current_phase = 'request_pending' then
    raise exception 'canary_command_requires_recovery';
  end if;
  if current_phase not in ('active', 'request_pending', 'recovery_required', 'cleanup_pending') then
    raise exception 'canary_cleanup_phase_rejected';
  end if;
  update app_private.production_product_canaries set phase = 'cleanup_pending', command_id = null, operation = null,
    target_ids = '{}', deadline_at = null, updated_at = clock_timestamp()
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid and generation = requested_generation;
  return true;
end;
$$;

create function app_private.cleanup_production_product_canary(uuid)
returns table (games_removed integer, notes_removed integer, lists_removed integer, relations_removed integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  owner text;
  note_ids uuid[];
  list_ids uuid[];
  relation_ids uuid[];
begin
  select owner_id into owner from app_private.production_product_canaries
  where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and generation = requested_generation and phase = 'cleanup_pending' for update;
  if not found then raise exception 'canary cleanup registry is not ready'; end if;
  if (select count(*) from app_private.games where id in (
        '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid,
        'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
      ) and is_production_canary is true) <> 2
    or exists (
      select 1 from app_private.games
      where id = '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid
        and (medium <> 'board_game' or display_name <> '正式 canary 桌遊' or external_game_identity_id is not null)
    )
    or exists (
      select 1 from app_private.games
      where id = 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
        and (medium <> 'video_game' or display_name <> '正式 canary 電子遊戲' or external_game_identity_id is not null)
    ) then
    raise exception 'canary fixture identity changed';
  end if;
  perform set_config('app.production_canary_cleanup_generation', requested_generation::text, true);
  select coalesce(array_agg(id), '{}'::uuid[]) into note_ids from app_private.notes
    where game_id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid);
  select coalesce(array_agg(id), '{}'::uuid[]) into list_ids from app_private.lists
    where is_production_canary and production_canary_generation = requested_generation;
  select coalesce(array_agg(id), '{}'::uuid[]) into relation_ids from app_private.game_relations
    where left_game_id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid)
      and right_game_id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid);
  delete from app_private.note_command_receipts where owner_id = owner and (target_id = any(note_ids) or target_id = any(array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid]));
  delete from app_private.list_command_receipts where owner_id = owner and (target_id = any(list_ids) or result_id = any(list_ids));
  delete from app_private.relation_command_receipts where owner_id = owner and (target_id = any(relation_ids) or result_id = any(relation_ids));
  delete from app_private.command_receipts where owner_id = owner and target_id = any(array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid]);
  delete from app_private.list_memberships where list_id = any(list_ids);
  delete from app_private.lists where id = any(list_ids) and is_production_canary and production_canary_generation = requested_generation;
  delete from app_private.game_relations where id = any(relation_ids);
  delete from app_private.notes where id = any(note_ids);
  delete from app_private.game_names where game_id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid);
  delete from app_private.games where id in ('21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid) and is_production_canary;
  get diagnostics games_removed = row_count;
  notes_removed := cardinality(note_ids);
  lists_removed := cardinality(list_ids);
  relations_removed := cardinality(relation_ids);
  delete from app_private.production_product_canaries where id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid and generation = requested_generation and phase = 'cleanup_pending';
  if not found then raise exception 'canary cleanup registry changed'; end if;
  return next;
end;
$$;

create function app_private.inspect_production_product_canary()
returns table (phase text, generation uuid, command_id uuid, deadline_at timestamptz, game_count bigint, note_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, app_private
as $$
  select canary.phase, canary.generation, canary.command_id, canary.deadline_at,
    (select count(*) from app_private.games where is_production_canary),
    (select count(*) from app_private.notes where game_id in (
      '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
    ))
  from app_private.production_product_canaries canary
  where canary.id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid;
$$;

create function app_private.list_production_product_canary_games(uuid, text)
returns table (id uuid, version bigint, medium text, display_name text, trashed_at timestamptz, created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, app_private
as $$
  select game.id, game.version, game.medium, game.display_name, game.trashed_at, game.created_at
  from app_private.games game
  join app_private.production_product_canaries canary
    on canary.id = 'adf265a4-6136-4b1e-88f6-51bfa01ed773'::uuid
    and canary.generation = $1 and canary.owner_id = $2
    and canary.phase in ('active', 'request_pending')
  where game.id in (
    '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid,
    'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid
  ) and game.is_production_canary is true
  order by game.id;
$$;

grant execute on function app_private.begin_production_product_canary_command(uuid, text, uuid, text, uuid[]) to app_runtime;
grant execute on function app_private.guard_production_product_canary_command(uuid, text, uuid, text, uuid[]) to app_runtime;
grant execute on function app_private.complete_production_product_canary_command(uuid, uuid) to app_runtime;
grant execute on function app_private.require_production_product_canary_recovery(uuid, uuid) to app_runtime;
grant execute on function app_private.prepare_production_product_canary_cleanup(uuid) to app_runtime;
grant execute on function app_private.cleanup_production_product_canary(uuid) to app_runtime;
grant execute on function app_private.inspect_production_product_canary() to app_runtime;
grant execute on function app_private.list_production_product_canary_games(uuid, text) to app_runtime;
grant execute on function app_private.claim_production_product_canary(uuid, text) to postgres;

revoke execute on function app_private.claim_production_product_canary(uuid, text) from public, anon, authenticated, service_role, app_runtime;
revoke execute on function app_private.begin_production_product_canary_command(uuid, text, uuid, text, uuid[]) from public, anon, authenticated, service_role;
revoke execute on function app_private.guard_production_product_canary_command(uuid, text, uuid, text, uuid[]) from public, anon, authenticated, service_role;
revoke execute on function app_private.guard_current_production_product_canary_command() from public, anon, authenticated, service_role, app_runtime;
revoke execute on function app_private.assert_production_product_canary_write() from public, anon, authenticated, service_role;
revoke execute on function app_private.complete_production_product_canary_command(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app_private.require_production_product_canary_recovery(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app_private.prepare_production_product_canary_cleanup(uuid) from public, anon, authenticated, service_role;
revoke execute on function app_private.cleanup_production_product_canary(uuid) from public, anon, authenticated, service_role;
revoke execute on function app_private.inspect_production_product_canary() from public, anon, authenticated, service_role;
revoke execute on function app_private.list_production_product_canary_games(uuid, text) from public, anon, authenticated, service_role;

reset role;
revoke app_migrator from postgres;

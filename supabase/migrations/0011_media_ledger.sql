grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.media_ingests
  add column idempotency_key text,
  add column reserved_asset_id uuid,
  add column channel text,
  add column purpose text,
  add column external_game_identity_id uuid,
  add column original_object_path text,
  add column original_file_name text,
  add column declared_mime_type text,
  add column declared_byte_size bigint,
  add column actual_mime_type text,
  add column actual_byte_size bigint,
  add column image_width integer,
  add column image_height integer,
  add column state text,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column stale_after timestamptz,
  add column last_error_code text,
  add column finalized_at timestamptz;

create table app_private.media_ingest_operations (
  idempotency_key text primary key,
  ingest_id uuid not null unique references app_private.media_ingests(id) on delete restrict deferrable initially deferred,
  reserved_asset_id uuid not null unique,
  game_id uuid not null references app_private.games(id) on delete restrict,
  purpose text not null check (purpose in ('gallery_image', 'custom_cover', 'attachment')),
  original_object_path text not null unique,
  original_file_name text not null,
  declared_mime_type text not null,
  declared_byte_size bigint not null check (declared_byte_size between 1 and 52428800),
  created_at timestamptz not null default now()
);

create table app_private.source_refresh_operations (
  operation_id uuid primary key,
  game_id uuid not null references app_private.games(id) on delete cascade,
  external_game_identity_id uuid not null references app_private.external_game_identities(id) on delete cascade,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table app_private.media_assets
  add column game_id uuid,
  add column purpose text,
  add column original_object_path text,
  add column original_file_name text,
  add column actual_mime_type text,
  add column width integer,
  add column height integer,
  add column caption text,
  add column display_name text,
  add column description text,
  add column removed_at timestamptz,
  add column removed_reason text,
  add column superseded_at timestamptz,
  add column authority_state text default 'legacy_unverified';

alter table app_private.media_derivatives
  add column spec text,
  add column authority_state text default 'legacy_unverified',
  add column current_object_path text,
  add column width integer,
  add column height integer,
  add column byte_size bigint,
  add column completed_at timestamptz,
  add column attempt_count integer default 0,
  add column next_attempt_at timestamptz,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column last_error_code text;

alter table app_private.media_derivatives
  drop constraint media_derivatives_state_check,
  add constraint media_derivatives_state_check check (state in ('pending', 'processing', 'ready', 'failed'));

create table app_private.media_derivative_attempts (
  id uuid primary key default gen_random_uuid(),
  derivative_id uuid not null references app_private.media_derivatives(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  object_path text not null unique,
  state text not null check (state in ('reserved', 'uploaded', 'adopted', 'cleanup_pending', 'cleaned')),
  last_error_code text,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  cleaned_at timestamptz,
  unique (derivative_id, attempt_number)
);

alter table app_private.games add column manual_cover_asset_id uuid;

alter table app_private.external_game_identities add column source_cover_asset_id uuid;

create function app_private.assert_valid_media_cover_pointer()
returns trigger language plpgsql as $$
begin
  if new.manual_cover_asset_id is not null then
    perform 1 from app_private.media_assets where id = new.manual_cover_asset_id for update;
  end if;
  if new.manual_cover_asset_id is not null and not exists (
    select 1 from app_private.media_assets asset
    where asset.id = new.manual_cover_asset_id
      and asset.authority_state = 'verified'
      and asset.game_id = new.id
      and asset.purpose in ('gallery_image', 'custom_cover')
      and asset.removed_at is null
      and asset.superseded_at is null
  ) then
    raise exception 'media manual cover must reference an active image from the same game';
  end if;
  if exists (
    select 1
    from app_private.external_game_identities identity
    join app_private.media_assets asset on asset.id = identity.source_cover_asset_id
    where (asset.game_id = new.id or identity.id = new.external_game_identity_id)
      and (asset.game_id is distinct from new.id or identity.id is distinct from new.external_game_identity_id)
  ) then
    raise exception 'game external identity must preserve its current source cover relationship';
  end if;

  return new;
end;
$$;

create function app_private.assert_valid_source_cover_pointer()
returns trigger language plpgsql as $$
begin
  if new.source_cover_asset_id is not null then
    perform 1 from app_private.media_assets where id = new.source_cover_asset_id for update;
  end if;
  if new.source_cover_asset_id is not null and not exists (
    select 1
    from app_private.media_assets asset
    join app_private.games game on game.id = asset.game_id
    where asset.id = new.source_cover_asset_id
      and asset.authority_state = 'verified'
      and asset.purpose = 'source_cover'
      and asset.removed_at is null
      and asset.superseded_at is null
      and game.external_game_identity_id = new.id
  ) then
    raise exception 'media source cover must reference the identity current source image';
  end if;
  return new;
end;
$$;

create function app_private.assert_valid_media_asset_references()
returns trigger language plpgsql as $$
begin
  perform 1 from app_private.games where id = new.game_id for update;
  perform 1 from app_private.games where manual_cover_asset_id = new.id for update;
  perform 1 from app_private.external_game_identities where source_cover_asset_id = new.id for update;
  perform 1 from app_private.media_derivatives where asset_id = new.id for update;
  if new.authority_state is null or new.authority_state not in ('legacy_unverified', 'verified') then
    raise exception 'media asset has invalid authority state';
  end if;
  if new.superseded_at is not null and new.purpose is distinct from 'source_cover' then
    raise exception 'only source cover may be superseded';
  end if;
  if new.authority_state = 'verified' and (
    new.kind is distinct from case when new.purpose = 'source_cover' then 'source_cover' else 'user_cover' end or
    new.object_key is distinct from new.original_object_path or
    new.mime_type is distinct from new.actual_mime_type
  ) then
    raise exception 'verified media asset aliases must match authority fields';
  end if;
  if new.authority_state = 'verified' and not exists (
    select 1 from app_private.media_ingests ingest
    where ingest.id = new.ingest_id
      and ingest.reserved_asset_id = new.id
      and ingest.game_id = new.game_id
      and ingest.purpose = new.purpose
      and ingest.original_object_path = new.original_object_path
      and ingest.original_file_name = new.original_file_name
      and ingest.actual_mime_type = new.actual_mime_type
      and ingest.actual_byte_size = new.byte_size
      and ingest.image_width is not distinct from new.width
      and ingest.image_height is not distinct from new.height
      and ingest.state = 'finalized'
  ) then
    raise exception 'media asset must match its finalized ingest ledger';
  end if;
  if new.authority_state = 'verified' and (
    new.game_id is null or
    new.purpose not in ('gallery_image', 'custom_cover', 'attachment', 'source_cover') or
    new.original_object_path is null or new.original_file_name is null or new.actual_mime_type is null or
    new.byte_size not between 1 and 52428800 or
    (new.purpose = 'attachment' and (new.width is not null or new.height is not null)) or
    (new.purpose <> 'attachment' and (new.width is null or new.height is null or new.width <= 0 or new.height <= 0 or new.width::bigint * new.height::bigint > 100000000)) or
    ((new.removed_at is null) <> (new.removed_reason is null)) or
    (new.removed_at is not null and new.purpose = 'source_cover') or
    (new.purpose = 'gallery_image' and (new.display_name is not null or new.description is not null)) or
    (new.purpose in ('custom_cover', 'source_cover') and (new.caption is not null or new.display_name is not null or new.description is not null)) or
    (new.purpose = 'attachment' and new.caption is not null)
  ) then
    raise exception 'verified media asset violates ledger contract';
  end if;
  if exists (
    select 1 from app_private.games game
    where game.manual_cover_asset_id = new.id
      and (new.game_id <> game.id or new.purpose not in ('gallery_image', 'custom_cover') or new.removed_at is not null or new.superseded_at is not null)
  ) then
    raise exception 'media manual cover must reference an active image from the same game';
  end if;
  if exists (
    select 1 from app_private.external_game_identities identity
    where identity.source_cover_asset_id = new.id
      and (new.authority_state <> 'verified' or new.purpose <> 'source_cover' or new.removed_at is not null or new.superseded_at is not null)
  ) then
    raise exception 'current source cover cannot be superseded';
  end if;
  if new.purpose = 'attachment' and exists (select 1 from app_private.media_derivatives derivative where derivative.asset_id = new.id) then
    raise exception 'media attachment cannot have a derivative';
  end if;
  if new.authority_state = 'verified' and new.purpose <> 'attachment' and not exists (
    select 1 from app_private.media_derivatives derivative
    where derivative.asset_id = new.id and derivative.authority_state = 'verified' and derivative.spec = 'thumb_webp_v1'
  ) then
    raise exception 'verified image asset must have its thumb_webp_v1 derivative';
  end if;
  return new;
end;
$$;

create function app_private.assert_image_media_derivative()
returns trigger language plpgsql as $$
begin
  perform 1 from app_private.media_assets where id = new.asset_id for update;
  if new.authority_state is null or new.authority_state not in ('legacy_unverified', 'verified') then
    raise exception 'media derivative has invalid authority state';
  end if;
  if new.authority_state = 'verified' and new.spec is distinct from 'thumb_webp_v1' then
    raise exception 'verified media derivative must use thumb_webp_v1 spec';
  end if;
  if new.authority_state = 'verified' and not exists (
    select 1 from app_private.media_assets asset
    where asset.id = new.asset_id and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
  ) then
    raise exception 'media attachment cannot have a derivative';
  end if;
  if new.authority_state = 'verified' and (
    new.state not in ('pending', 'processing', 'ready', 'failed') or
    new.attempt_count is null or new.attempt_count < 0 or
    new.object_key is null or
    not (
      (new.state = 'processing' and new.lease_token is not null and new.lease_until is not null) or
      (new.state <> 'processing' and new.lease_token is null and new.lease_until is null)
    ) or
    (new.state = 'ready' and (new.current_object_path is null or new.object_key is distinct from new.current_object_path or new.width is null or new.height is null or new.byte_size is null or new.width <= 0 or new.height <= 0 or new.byte_size <= 0 or new.completed_at is null)) or
    (new.state <> 'ready' and (new.current_object_path is not null or new.width is not null or new.height is not null or new.byte_size is not null or new.completed_at is not null))
  ) then
    raise exception 'verified media derivative violates ledger contract';
  end if;
  return new;
end;
$$;

create function app_private.protect_finalized_media_ingest()
returns trigger language plpgsql as $$
declare
  asset app_private.media_assets%rowtype;
begin
  if new.channel is not null and (
    new.idempotency_key is null or new.reserved_asset_id is null or new.game_id is null or
    new.purpose is null or new.original_object_path is null or new.original_file_name is null or
    new.declared_mime_type is null or new.state is null or new.stale_after is null or
    new.channel not in ('browser_tus', 'source_fetch') or
    new.purpose not in ('gallery_image', 'custom_cover', 'attachment', 'source_cover') or
    not (
      (new.purpose = 'source_cover' and new.channel = 'source_fetch' and new.external_game_identity_id is not null) or
      (new.purpose in ('gallery_image', 'custom_cover', 'attachment') and new.channel = 'browser_tus' and new.external_game_identity_id is null)
    ) or
    (new.channel = 'source_fetch' and new.declared_byte_size is not null and new.declared_byte_size not between 1 and 52428800) or
    (new.channel = 'browser_tus' and new.declared_byte_size not between 1 and 52428800) or
    (new.actual_byte_size is not null and new.actual_byte_size not between 1 and 52428800) or
    ((new.image_width is null) <> (new.image_height is null)) or
    (new.image_width is not null and (new.image_width <= 0 or new.image_height <= 0 or new.image_width::bigint * new.image_height::bigint > 100000000)) or
    new.state not in ('issued', 'finalizing', 'finalized', 'cleanup_pending', 'expired') or
    (new.state = 'finalizing') <> (new.lease_token is not null and new.lease_until is not null) or
    (new.state = 'finalized' and (new.finalized_at is null or new.actual_mime_type is null or new.actual_byte_size not between 1 and 52428800))
  ) then
    raise exception 'media ingest violates ledger contract';
  end if;
  if new.channel = 'browser_tus' and not exists (
    select 1 from app_private.media_ingest_operations operation
    where operation.idempotency_key = new.idempotency_key
      and operation.ingest_id = new.id
      and operation.reserved_asset_id = new.reserved_asset_id
      and operation.game_id = new.game_id
      and operation.purpose = new.purpose
      and operation.original_object_path = new.original_object_path
      and operation.original_file_name = new.original_file_name
      and operation.declared_mime_type = new.declared_mime_type
      and operation.declared_byte_size = new.declared_byte_size
  ) then
    raise exception 'browser media ingest must match its idempotency ledger';
  end if;
  if new.purpose = 'source_cover' and not exists (
    select 1 from app_private.games game
    where game.id = new.game_id and game.external_game_identity_id = new.external_game_identity_id
  ) then
    raise exception 'source cover ingest must match its game external identity';
  end if;
  select * into asset from app_private.media_assets where ingest_id = new.id and authority_state = 'verified';
  if found and (
    new.state <> 'finalized' or
    new.reserved_asset_id is distinct from asset.id or
    new.game_id is distinct from asset.game_id or
    new.purpose is distinct from asset.purpose or
    new.original_object_path is distinct from asset.original_object_path or
    new.original_file_name is distinct from asset.original_file_name or
    new.actual_mime_type is distinct from asset.actual_mime_type or
    new.actual_byte_size is distinct from asset.byte_size or
    new.image_width is distinct from asset.width or
    new.image_height is distinct from asset.height
  ) then
    raise exception 'finalized media ingest authority fields are immutable';
  end if;
  if new.state = 'finalized' and not found then
    raise exception 'finalized media ingest must match a verified asset';
  end if;
  return new;
end;
$$;

create function app_private.prevent_finalized_media_ingest_authority_update()
returns trigger language plpgsql as $$
begin
  if old.state = 'finalized' and (
    new.id is distinct from old.id or
    new.idempotency_key is distinct from old.idempotency_key or
    new.reserved_asset_id is distinct from old.reserved_asset_id or
    new.channel is distinct from old.channel or
    new.purpose is distinct from old.purpose or
    new.game_id is distinct from old.game_id or
    new.external_game_identity_id is distinct from old.external_game_identity_id or
    new.original_object_path is distinct from old.original_object_path or
    new.original_file_name is distinct from old.original_file_name or
    new.declared_mime_type is distinct from old.declared_mime_type or
    new.declared_byte_size is distinct from old.declared_byte_size or
    new.actual_mime_type is distinct from old.actual_mime_type or
    new.actual_byte_size is distinct from old.actual_byte_size or
    new.image_width is distinct from old.image_width or
    new.image_height is distinct from old.image_height or
    new.state is distinct from old.state or
    new.finalized_at is distinct from old.finalized_at or
    new.source_url is distinct from old.source_url or
    new.object_key is distinct from old.object_key or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'finalized media ingest authority fields are immutable';
  end if;
  return new;
end;
$$;

create function app_private.prevent_finalized_media_ingest_delete()
returns trigger language plpgsql as $$
begin
  if old.state = 'finalized' then
    raise exception 'cannot delete finalized media ingest';
  end if;
  return old;
end;
$$;

create function app_private.prevent_finalized_media_asset_delete()
returns trigger language plpgsql as $$
begin
  if old.authority_state = 'verified' and exists (
    select 1 from app_private.media_ingests ingest
    where ingest.id = old.ingest_id and ingest.state = 'finalized' and ingest.reserved_asset_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'cannot delete verified asset referenced by finalized ingest';
    end if;
    if new.id is distinct from old.id or new.ingest_id is distinct from old.ingest_id or new.authority_state is distinct from old.authority_state then
      raise exception 'cannot detach verified asset referenced by finalized ingest';
    end if;
    if new.game_id is distinct from old.game_id or
       new.purpose is distinct from old.purpose or
       new.original_object_path is distinct from old.original_object_path or
       new.original_file_name is distinct from old.original_file_name or
       new.actual_mime_type is distinct from old.actual_mime_type or
       new.byte_size is distinct from old.byte_size or
       new.width is distinct from old.width or
       new.height is distinct from old.height or
       new.kind is distinct from old.kind or
       new.object_key is distinct from old.object_key or
       new.mime_type is distinct from old.mime_type or
       new.created_at is distinct from old.created_at then
      raise exception 'finalized media asset authority fields are immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create function app_private.prevent_verified_media_derivative_identity_update()
returns trigger language plpgsql as $$
begin
  if old.authority_state = 'verified' and (
    new.id is distinct from old.id or
    new.asset_id is distinct from old.asset_id or
    new.spec is distinct from old.spec or
    new.authority_state is distinct from old.authority_state or
    new.kind is distinct from old.kind or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'verified media derivative identity fields are immutable';
  end if;
  return new;
end;
$$;

create function app_private.prevent_verified_media_derivative_delete()
returns trigger language plpgsql as $$
begin
  if old.authority_state = 'verified' and exists (
    select 1 from app_private.media_assets asset
    where asset.id = old.asset_id and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
  ) then
    raise exception 'cannot delete verified image derivative';
  end if;
  return old;
end;
$$;

create constraint trigger games_valid_manual_cover
after insert or update on app_private.games
deferrable initially immediate for each row execute function app_private.assert_valid_media_cover_pointer();

create constraint trigger external_identities_valid_source_cover
after insert or update on app_private.external_game_identities
deferrable initially immediate for each row execute function app_private.assert_valid_source_cover_pointer();

create constraint trigger media_assets_valid_references
after insert or update on app_private.media_assets
deferrable initially immediate for each row execute function app_private.assert_valid_media_asset_references();

create constraint trigger media_derivatives_image_only
after insert or update on app_private.media_derivatives
deferrable initially immediate for each row execute function app_private.assert_image_media_derivative();

create constraint trigger media_ingests_protect_finalized
after insert or update on app_private.media_ingests
deferrable initially immediate for each row execute function app_private.protect_finalized_media_ingest();

create trigger media_assets_prevent_finalized_delete
before delete on app_private.media_assets
for each row execute function app_private.prevent_finalized_media_asset_delete();

create trigger media_assets_prevent_finalized_detach
before update on app_private.media_assets
for each row execute function app_private.prevent_finalized_media_asset_delete();

create trigger media_ingests_prevent_finalized_authority_update
before update on app_private.media_ingests
for each row execute function app_private.prevent_finalized_media_ingest_authority_update();

create trigger media_ingests_prevent_finalized_delete
before delete on app_private.media_ingests
for each row execute function app_private.prevent_finalized_media_ingest_delete();

create trigger media_derivatives_prevent_verified_identity_update
before update on app_private.media_derivatives
for each row execute function app_private.prevent_verified_media_derivative_identity_update();

create trigger media_derivatives_prevent_verified_delete
before delete on app_private.media_derivatives
for each row execute function app_private.prevent_verified_media_derivative_delete();

create index media_ingests_finalize_candidates_idx on app_private.media_ingests (state, lease_until);
create index media_ingests_cleanup_candidates_idx on app_private.media_ingests (state, stale_after);
create index media_assets_game_id_idx on app_private.media_assets (game_id) where removed_at is null and superseded_at is null;
create index media_derivative_attempts_derivative_id_idx on app_private.media_derivative_attempts (derivative_id);

alter table app_private.media_derivative_attempts enable row level security;
alter table app_private.media_ingest_operations enable row level security;
alter table app_private.source_refresh_operations enable row level security;
create policy runtime_media_derivative_attempts on app_private.media_derivative_attempts for all to app_runtime using (true) with check (true);
create policy runtime_media_ingest_operations_select on app_private.media_ingest_operations for select to app_runtime using (true);
create policy runtime_media_ingest_operations_insert on app_private.media_ingest_operations for insert to app_runtime with check (true);
create policy runtime_source_refresh_operations_select on app_private.source_refresh_operations for select to app_runtime using (true);
create policy runtime_source_refresh_operations_insert on app_private.source_refresh_operations for insert to app_runtime with check (true);

revoke execute on function app_private.assert_valid_media_cover_pointer() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_valid_source_cover_pointer() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_valid_media_asset_references() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_image_media_derivative() from public, anon, authenticated, service_role;
revoke execute on function app_private.protect_finalized_media_ingest() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_ingest_authority_update() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_ingest_delete() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_asset_delete() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_verified_media_derivative_identity_update() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_verified_media_derivative_delete() from public, anon, authenticated, service_role;

-- TODO(#media-ledger-contract): 完成 Storage 重驗與雙版本部署後，另以 contract migration
-- 收緊新增欄位 NOT NULL、移除 legacy_unverified 相容路徑，並清理由舊程式建立的列。

reset role;
revoke app_migrator from postgres;

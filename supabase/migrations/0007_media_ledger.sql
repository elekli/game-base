grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.media_ingests
  add column idempotency_key text,
  add column reserved_asset_id uuid,
  add column channel text,
  add column purpose text,
  add column external_game_identity_id uuid references app_private.external_game_identities(id) on delete restrict,
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

alter table app_private.media_ingests
  add constraint media_ingests_idempotency_key_key unique (idempotency_key),
  add constraint media_ingests_reserved_asset_id_key unique (reserved_asset_id),
  add constraint media_ingests_original_object_path_key unique (original_object_path),
  add constraint media_ingests_channel_check check (channel in ('browser_tus', 'source_fetch')),
  add constraint media_ingests_purpose_check check (purpose in ('gallery_image', 'custom_cover', 'attachment', 'source_cover')),
  add constraint media_ingests_target_check check (
    (purpose = 'source_cover' and channel = 'source_fetch' and external_game_identity_id is not null) or
    (purpose in ('gallery_image', 'custom_cover', 'attachment') and channel = 'browser_tus' and external_game_identity_id is null)
  ),
  add constraint media_ingests_declared_byte_size_check check (
    (channel = 'source_fetch' and (declared_byte_size is null or declared_byte_size between 1 and 52428800)) or
    (channel = 'browser_tus' and declared_byte_size between 1 and 52428800)
  ),
  add constraint media_ingests_actual_byte_size_check check (actual_byte_size is null or actual_byte_size between 1 and 52428800),
  add constraint media_ingests_image_dimensions_check check (
    (image_width is null and image_height is null) or
    (image_width > 0 and image_height > 0 and image_width::bigint * image_height::bigint <= 100000000)
  ),
  add constraint media_ingests_state_check check (state in ('issued', 'finalizing', 'finalized', 'cleanup_pending', 'expired')),
  add constraint media_ingests_lease_check check (
    (state = 'finalizing' and lease_token is not null and lease_until is not null) or
    (state <> 'finalizing' and lease_token is null and lease_until is null)
  ),
  add constraint media_ingests_finalized_check check (
    state <> 'finalized' or
    (finalized_at is not null and actual_mime_type is not null and actual_byte_size between 1 and 52428800)
  ) not valid;

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

alter table app_private.media_assets drop constraint if exists media_assets_kind_check;
alter table app_private.media_assets
  add constraint media_assets_game_id_fkey foreign key (game_id) references app_private.games(id) on delete cascade,
  add constraint media_assets_authority_state_check check (authority_state in ('legacy_unverified', 'verified')),
  add constraint media_assets_purpose_check check (purpose is null or purpose in ('gallery_image', 'custom_cover', 'attachment', 'source_cover')),
  add constraint media_assets_verified_check check (
    authority_state <> 'verified' or
    (game_id is not null and purpose is not null and original_object_path is not null and original_file_name is not null and
     actual_mime_type is not null and byte_size between 1 and 52428800)
  ),
  add constraint media_assets_dimensions_check check (
    authority_state <> 'verified' or
    (purpose = 'attachment' and width is null and height is null) or
    (purpose <> 'attachment' and width > 0 and height > 0 and width::bigint * height::bigint <= 100000000)
  ),
  add constraint media_assets_removal_check check (
    (removed_at is null and removed_reason is null) or
    (removed_at is not null and removed_reason is not null and purpose <> 'source_cover')
  ),
  add constraint media_assets_metadata_check check (
    (purpose = 'gallery_image' and display_name is null and description is null) or
    (purpose = 'custom_cover' and caption is null and display_name is null and description is null) or
    (purpose = 'attachment' and caption is null) or
    (purpose = 'source_cover' and caption is null and display_name is null and description is null)
  ),
  add constraint media_assets_ingest_identity_unique unique (ingest_id, id),
  add constraint media_assets_original_object_path_key unique (original_object_path);

alter table app_private.media_derivatives drop constraint if exists media_derivatives_state_check;
alter table app_private.media_derivatives alter column object_key drop not null;
alter table app_private.media_derivatives
  add column spec text,
  add column authority_state text default 'legacy_unverified',
  add column current_object_path text,
  add column width integer,
  add column height integer,
  add column byte_size bigint,
  add column completed_at timestamptz,
  add column attempt_count integer not null default 0,
  add column next_attempt_at timestamptz,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column last_error_code text;

alter table app_private.media_derivatives
  add constraint media_derivatives_authority_state_check check (authority_state in ('legacy_unverified', 'verified')),
  add constraint media_derivatives_spec_check check (spec = 'thumb_webp_v1'),
  add constraint media_derivatives_state_check check (state in ('pending', 'processing', 'ready', 'failed')),
  add constraint media_derivatives_attempt_count_check check (attempt_count >= 0),
  add constraint media_derivatives_lease_check check (
    (state = 'processing' and lease_token is not null and lease_until is not null) or
    (state <> 'processing' and lease_token is null and lease_until is null)
  ),
  add constraint media_derivatives_ready_check check (
    authority_state <> 'verified' or
    (state = 'ready' and current_object_path is not null and width > 0 and height > 0 and byte_size > 0 and completed_at is not null) or
    (state <> 'ready' and current_object_path is null and width is null and height is null and byte_size is null and completed_at is null)
  ),
  add constraint media_derivatives_asset_spec_key unique (asset_id, spec);

create unique index media_derivatives_current_object_path_key
  on app_private.media_derivatives (current_object_path)
  where current_object_path is not null;

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
alter table app_private.games add constraint games_manual_cover_asset_id_fkey
  foreign key (manual_cover_asset_id) references app_private.media_assets(id) on delete restrict;

alter table app_private.external_game_identities add column source_cover_asset_id uuid;
alter table app_private.external_game_identities add constraint external_game_identities_source_cover_asset_id_fkey
  foreign key (source_cover_asset_id) references app_private.media_assets(id) on delete restrict;

create function app_private.assert_valid_media_cover_pointer()
returns trigger language plpgsql as $$
begin
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
  if new.superseded_at is not null and new.purpose is distinct from 'source_cover' then
    raise exception 'only source cover may be superseded';
  end if;
  if new.authority_state = 'verified' and (
    new.kind is distinct from new.purpose or
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
  return new;
end;
$$;

create function app_private.assert_image_media_derivative()
returns trigger language plpgsql as $$
begin
  if new.authority_state = 'verified' and new.spec is distinct from 'thumb_webp_v1' then
    raise exception 'verified media derivative must use thumb_webp_v1 spec';
  end if;
  if new.authority_state = 'verified' and not exists (
    select 1 from app_private.media_assets asset
    where asset.id = new.asset_id and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
  ) then
    raise exception 'media attachment cannot have a derivative';
  end if;
  return new;
end;
$$;

create function app_private.protect_finalized_media_ingest()
returns trigger language plpgsql as $$
declare
  asset app_private.media_assets%rowtype;
begin
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

create index media_ingests_finalize_candidates_idx on app_private.media_ingests (state, lease_until);
create index media_ingests_cleanup_candidates_idx on app_private.media_ingests (state, stale_after);
create index media_assets_game_id_idx on app_private.media_assets (game_id) where removed_at is null and superseded_at is null;
create index media_derivative_attempts_derivative_id_idx on app_private.media_derivative_attempts (derivative_id);

alter table app_private.media_derivative_attempts enable row level security;
alter table app_private.source_refresh_operations enable row level security;
create policy runtime_media_derivative_attempts on app_private.media_derivative_attempts for all to app_runtime using (true) with check (true);
create policy runtime_source_refresh_operations_select on app_private.source_refresh_operations for select to app_runtime using (true);
create policy runtime_source_refresh_operations_insert on app_private.source_refresh_operations for insert to app_runtime with check (true);

revoke all on app_private.media_derivative_attempts from public, anon, authenticated, service_role;
grant select, insert, update, delete on app_private.media_derivative_attempts to app_runtime;
revoke update, delete on app_private.source_refresh_operations from app_runtime;
grant select, insert on app_private.source_refresh_operations to app_runtime;
revoke execute on function app_private.assert_valid_media_cover_pointer() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_valid_source_cover_pointer() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_valid_media_asset_references() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_image_media_derivative() from public, anon, authenticated, service_role;
revoke execute on function app_private.protect_finalized_media_ingest() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_ingest_authority_update() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_ingest_delete() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_finalized_media_asset_delete() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_verified_media_derivative_identity_update() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_system_platform_mutation() from public;

-- TODO(#media-ledger-contract): 完成 Storage 重驗與雙版本部署後，另以 contract migration
-- 收緊新增欄位 NOT NULL、移除 legacy_unverified 相容路徑，並清理由舊程式建立的列。

reset role;
revoke app_migrator from postgres;

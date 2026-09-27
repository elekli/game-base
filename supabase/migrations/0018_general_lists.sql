grant app_migrator to postgres;
set local role app_migrator;

create table app_private.lists (
  id uuid primary key,
  name text not null check (name = btrim(name) and length(name) between 1 and 120),
  name_key text generated always as (lower(btrim(name)) collate "C") stored unique,
  version bigint not null default 1 check (version > 0),
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table app_private.external_game_references (
  external_game_identity_id uuid primary key references app_private.external_game_identities(id) on delete restrict,
  name text not null check (length(btrim(name)) > 0),
  release_year integer check (release_year between 0 and 9999),
  thumbnail_object_key text,
  thumbnail_state text not null default 'missing' check (thumbnail_state in ('missing', 'pending', 'ready', 'failed')),
  thumbnail_lease_token uuid,
  thumbnail_lease_until timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((thumbnail_state = 'ready') = (thumbnail_object_key is not null)),
  check ((thumbnail_lease_token is null) = (thumbnail_lease_until is null)),
  check ((thumbnail_state = 'pending') = (thumbnail_lease_token is not null))
);

create table app_private.list_memberships (
  id uuid primary key,
  list_id uuid not null references app_private.lists(id) on delete restrict,
  game_id uuid references app_private.games(id) on delete restrict,
  external_game_identity_id uuid references app_private.external_game_identities(id) on delete restrict,
  description text check (description is null or length(description) <= 1000),
  version bigint not null default 1 check (version > 0),
  removed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(game_id, external_game_identity_id) = 1),
  unique (list_id, game_id),
  unique (list_id, external_game_identity_id)
);
create index list_memberships_game_idx on app_private.list_memberships(game_id) where removed_at is null;
create index list_memberships_external_idx on app_private.list_memberships(external_game_identity_id) where removed_at is null;

create table app_private.list_command_receipts (
  command_id uuid primary key,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  command_kind text not null check (command_kind in ('list.create', 'list.add', 'list.archive', 'list.restore', 'list.member.remove', 'list.member.restore', 'list.member.describe')),
  target_id uuid,
  expected_version bigint,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  result_version bigint,
  result_state text check (result_state in ('active', 'archived', 'removed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  check ((result_id is null) = (result_version is null) and (result_version is null) = (result_state is null)),
  check (expires_at = created_at + interval '90 days')
);
create index list_command_receipts_expiry_idx on app_private.list_command_receipts(expires_at, command_id);

alter table app_private.lists enable row level security;
alter table app_private.external_game_references enable row level security;
alter table app_private.list_memberships enable row level security;
alter table app_private.list_command_receipts enable row level security;
create policy runtime_lists on app_private.lists for all to app_runtime using (true) with check (true);
create policy runtime_external_game_references on app_private.external_game_references for all to app_runtime using (true) with check (true);
create policy runtime_list_memberships on app_private.list_memberships for all to app_runtime using (true) with check (true);
create policy runtime_list_command_receipts on app_private.list_command_receipts for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

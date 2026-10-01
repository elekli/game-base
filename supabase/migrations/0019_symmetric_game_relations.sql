grant app_migrator to postgres;
set local role app_migrator;

create table app_private.game_relations (
  id uuid primary key default gen_random_uuid(),
  left_game_id uuid references app_private.games(id) on delete restrict,
  left_external_game_identity_id uuid references app_private.external_game_identities(id) on delete restrict,
  right_game_id uuid references app_private.games(id) on delete restrict,
  right_external_game_identity_id uuid references app_private.external_game_identities(id) on delete restrict,
  left_reference_key text generated always as (
    case when left_game_id is not null then '1:' || left_game_id::text
      else '0:' || left_external_game_identity_id::text end
  ) stored,
  right_reference_key text generated always as (
    case when right_game_id is not null then '1:' || right_game_id::text
      else '0:' || right_external_game_identity_id::text end
  ) stored,
  description text check (description is null or length(description) <= 1000),
  version bigint not null default 1 check (version > 0),
  removed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(left_game_id, left_external_game_identity_id) = 1),
  check (num_nonnulls(right_game_id, right_external_game_identity_id) = 1),
  check (left_reference_key < right_reference_key),
  constraint game_relations_reference_pair_unique unique (left_reference_key, right_reference_key)
);
create index game_relations_left_game_idx on app_private.game_relations(left_game_id) where removed_at is null;
create index game_relations_right_game_idx on app_private.game_relations(right_game_id) where removed_at is null;
create index game_relations_left_external_idx on app_private.game_relations(left_external_game_identity_id) where removed_at is null;
create index game_relations_right_external_idx on app_private.game_relations(right_external_game_identity_id) where removed_at is null;

create table app_private.relation_command_receipts (
  command_id uuid primary key,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  command_kind text not null check (command_kind in ('relation.add', 'relation.remove', 'relation.restore', 'relation.describe')),
  target_id uuid,
  expected_version bigint,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  result_version bigint,
  result_state text check (result_state in ('active', 'removed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  check ((result_id is null) = (result_version is null) and (result_version is null) = (result_state is null)),
  check (expires_at = created_at + interval '90 days')
);
create index relation_command_receipts_expiry_idx on app_private.relation_command_receipts(expires_at, command_id);

alter table app_private.game_relations enable row level security;
alter table app_private.relation_command_receipts enable row level security;
create policy runtime_game_relations on app_private.game_relations for all to app_runtime using (true) with check (true);
create policy runtime_relation_command_receipts on app_private.relation_command_receipts for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

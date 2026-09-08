grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.games
  add column version bigint not null default 1 check (version > 0);

create table app_private.command_receipts (
  command_id uuid primary key,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  command_kind text not null check (command_kind = 'game.edit'),
  target_kind text not null check (target_kind = 'game'),
  target_id uuid not null,
  expected_version bigint not null check (expected_version > 0),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result_version bigint check (result_version > 0),
  result_state text check (result_state in ('active', 'trashed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  check ((result_version is null) = (result_state is null)),
  check (expires_at = created_at + interval '90 days')
);

create index command_receipts_expiry_idx
  on app_private.command_receipts (expires_at, command_id);

alter table app_private.command_receipts enable row level security;

create policy runtime_command_receipts
  on app_private.command_receipts
  for all to app_runtime
  using (true)
  with check (true);

reset role;
revoke app_migrator from postgres;

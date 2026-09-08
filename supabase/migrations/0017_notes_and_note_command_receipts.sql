grant app_migrator to postgres;
set local role app_migrator;

create table app_private.notes (
  id uuid primary key,
  game_id uuid not null references app_private.games(id) on delete restrict,
  content text not null check (length(regexp_replace(content, '[[:space:]]', '', 'g')) > 0),
  version bigint not null default 1 check (version > 0),
  removed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index notes_active_game_idx
  on app_private.notes (game_id, created_at, id)
  where removed_at is null;

create table app_private.note_command_receipts (
  command_id uuid primary key,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  command_kind text not null check (command_kind in ('note.create', 'note.update', 'note.remove', 'note.restore')),
  target_kind text not null check (target_kind in ('game', 'note')),
  target_id uuid not null,
  expected_version bigint check (expected_version > 0),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  result_version bigint check (result_version > 0),
  result_state text check (result_state in ('active', 'removed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  check ((command_kind = 'note.create' and target_kind = 'game' and expected_version is null)
    or (command_kind <> 'note.create' and target_kind = 'note' and expected_version is not null)),
  check ((result_id is null) = (result_version is null) and (result_version is null) = (result_state is null)),
  check (expires_at = created_at + interval '90 days')
);

create index note_command_receipts_expiry_idx
  on app_private.note_command_receipts (expires_at, command_id);

alter table app_private.notes enable row level security;
alter table app_private.note_command_receipts enable row level security;
create policy runtime_notes on app_private.notes for all to app_runtime using (true) with check (true);
create policy runtime_note_command_receipts on app_private.note_command_receipts for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

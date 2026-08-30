grant app_migrator to postgres;
set local role app_migrator;

create table if not exists app_private.external_game_identities (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('bgg', 'igdb')),
  source_id text not null check (source_id ~ '^(0|[1-9][0-9]*)$'),
  medium text not null check (medium in ('board_game', 'video_game')),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, source_id),
  check ((provider = 'bgg' and medium = 'board_game') or (provider = 'igdb' and medium = 'video_game'))
);

create table if not exists app_private.games (
  id uuid primary key default gen_random_uuid(),
  medium text not null check (medium in ('board_game', 'video_game')),
  display_name text not null check (length(btrim(display_name)) > 0),
  external_game_identity_id uuid unique references app_private.external_game_identities(id),
  trashed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app_private.game_names (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references app_private.games(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  name_kind text not null check (name_kind in ('custom', 'source', 'alias')),
  unique (game_id, name, name_kind)
);

alter table app_private.external_game_identities enable row level security;
alter table app_private.games enable row level security;
alter table app_private.game_names enable row level security;

drop policy if exists runtime_external_identity on app_private.external_game_identities;
create policy runtime_external_identity on app_private.external_game_identities for all to app_runtime using (true) with check (true);
drop policy if exists runtime_games on app_private.games;
create policy runtime_games on app_private.games for all to app_runtime using (true) with check (true);
drop policy if exists runtime_game_names on app_private.game_names;
create policy runtime_game_names on app_private.game_names for all to app_runtime using (true) with check (true);

create index if not exists games_display_name_idx on app_private.games (display_name) where trashed_at is null;

reset role;
revoke app_migrator from postgres;

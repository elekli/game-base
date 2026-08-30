grant app_migrator to postgres;
set local role app_migrator;

create table if not exists app_private.source_categories (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('bgg', 'igdb')),
  category_kind text not null,
  source_category_id text not null,
  name text not null,
  unique (provider, category_kind, source_category_id)
);

create table if not exists app_private.external_game_categories (
  identity_id uuid not null references app_private.external_game_identities(id) on delete cascade,
  category_id uuid not null references app_private.source_categories(id) on delete restrict,
  primary key (identity_id, category_id)
);

create table if not exists app_private.source_contributions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references app_private.external_game_identities(id) on delete cascade,
  source_contributor_id text not null,
  name text not null,
  entity_kind text not null check (entity_kind in ('person', 'company')),
  role text not null check (role in ('design', 'developer', 'art', 'publisher')),
  unique (identity_id, source_contributor_id, role)
);

create table if not exists app_private.external_player_profiles (
  identity_id uuid primary key references app_private.external_game_identities(id) on delete cascade,
  min_players integer,
  max_players integer,
  supports_solo text not null check (supports_solo in ('supported', 'unsupported', 'unknown')),
  check ((min_players is null and max_players is null) or (min_players is not null and max_players is not null and min_players >= 1 and min_players <= max_players))
);

create table if not exists app_private.media_ingests (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references app_private.games(id) on delete cascade,
  source_url text not null,
  object_key text not null unique,
  original_state text not null check (original_state in ('pending', 'ready', 'failed')),
  thumbnail_state text not null check (thumbnail_state in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists app_private.media_assets (
  id uuid primary key default gen_random_uuid(),
  ingest_id uuid not null unique references app_private.media_ingests(id) on delete cascade,
  kind text not null check (kind in ('source_cover', 'user_cover')),
  object_key text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0 and byte_size <= 52428800),
  created_at timestamptz not null default now()
);

create table if not exists app_private.media_derivatives (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references app_private.media_assets(id) on delete cascade,
  kind text not null check (kind = 'thumbnail_webp'),
  object_key text not null unique,
  state text not null check (state in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  unique (asset_id, kind)
);

create index if not exists external_game_categories_category_id_idx on app_private.external_game_categories (category_id);
create index if not exists source_contributions_identity_id_idx on app_private.source_contributions (identity_id);
create index if not exists media_ingests_game_id_idx on app_private.media_ingests (game_id);
create index if not exists media_derivatives_asset_id_idx on app_private.media_derivatives (asset_id);

alter table app_private.source_categories enable row level security;
drop policy if exists runtime_source_categories on app_private.source_categories;
alter table app_private.external_game_categories enable row level security;
drop policy if exists runtime_external_game_categories on app_private.external_game_categories;
alter table app_private.source_contributions enable row level security;
drop policy if exists runtime_source_contributions on app_private.source_contributions;
alter table app_private.external_player_profiles enable row level security;
drop policy if exists runtime_external_player_profiles on app_private.external_player_profiles;
alter table app_private.media_ingests enable row level security;
drop policy if exists runtime_media_ingests on app_private.media_ingests;
alter table app_private.media_assets enable row level security;
drop policy if exists runtime_media_assets on app_private.media_assets;
alter table app_private.media_derivatives enable row level security;
drop policy if exists runtime_media_derivatives on app_private.media_derivatives;

create policy runtime_source_categories on app_private.source_categories for all to app_runtime using (true) with check (true);
create policy runtime_external_game_categories on app_private.external_game_categories for all to app_runtime using (true) with check (true);
create policy runtime_source_contributions on app_private.source_contributions for all to app_runtime using (true) with check (true);
create policy runtime_external_player_profiles on app_private.external_player_profiles for all to app_runtime using (true) with check (true);
create policy runtime_media_ingests on app_private.media_ingests for all to app_runtime using (true) with check (true);
create policy runtime_media_assets on app_private.media_assets for all to app_runtime using (true) with check (true);
create policy runtime_media_derivatives on app_private.media_derivatives for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.games add column if not exists player_count_note text;
create unique index if not exists game_names_custom_unique on app_private.game_names (game_id, name_kind) where name_kind = 'custom';

create table if not exists app_private.platforms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  normalized_name text not null check (normalized_name = lower(btrim(normalized_name))),
  is_system boolean not null default false,
  unique (normalized_name)
);

create table if not exists app_private.game_platforms (
  game_id uuid not null references app_private.games(id) on delete cascade,
  platform_id uuid not null references app_private.platforms(id) on delete restrict,
  primary key (game_id, platform_id)
);

create table if not exists app_private.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  normalized_name text not null check (normalized_name = lower(btrim(normalized_name))),
  unique (normalized_name)
);

create table if not exists app_private.game_tags (
  game_id uuid not null references app_private.games(id) on delete cascade,
  tag_id uuid not null references app_private.tags(id) on delete restrict,
  primary key (game_id, tag_id)
);

create table if not exists app_private.contributors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  entity_kind text not null check (entity_kind in ('person', 'company')),
  source_provider text check (source_provider in ('bgg', 'igdb')),
  source_contributor_id text,
  check ((source_provider is null and source_contributor_id is null) or (source_provider is not null and source_contributor_id is not null))
);

create unique index if not exists contributors_source_identity_unique on app_private.contributors (source_provider, source_contributor_id) where source_provider is not null;

alter table app_private.source_contributions add column if not exists contributor_id uuid references app_private.contributors(id) on delete restrict;

create table if not exists app_private.manual_contributions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references app_private.games(id) on delete cascade,
  contributor_id uuid not null references app_private.contributors(id) on delete restrict,
  role text not null check (role in ('design', 'developer', 'art', 'publisher')),
  unique (game_id, contributor_id, role)
);

create table if not exists app_private.external_supported_platforms (
  identity_id uuid not null references app_private.external_game_identities(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  normalized_name text generated always as (lower(btrim(name))) stored,
  primary key (identity_id, normalized_name)
);

create index if not exists game_platforms_platform_id_idx on app_private.game_platforms (platform_id);
create index if not exists game_tags_tag_id_idx on app_private.game_tags (tag_id);
create index if not exists manual_contributions_contributor_id_idx on app_private.manual_contributions (contributor_id);
create index if not exists external_supported_platforms_name_idx on app_private.external_supported_platforms (normalized_name);

create or replace function app_private.prevent_system_platform_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE' and old.is_system) or (tg_op = 'UPDATE' and old.is_system and (new.name <> old.name or new.normalized_name <> old.normalized_name or new.is_system <> old.is_system)) then
    raise exception 'system platform is immutable';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists prevent_system_platform_mutation on app_private.platforms;
create trigger prevent_system_platform_mutation before update or delete on app_private.platforms for each row execute function app_private.prevent_system_platform_mutation();

insert into app_private.platforms (name, normalized_name, is_system) values
  ('Steam', 'steam', true),
  ('PS5', 'ps5', true),
  ('Xbox Series', 'xbox series', true),
  ('Nintendo Switch', 'nintendo switch', true)
on conflict (normalized_name) do update set is_system = true;

alter table app_private.platforms enable row level security;
alter table app_private.game_platforms enable row level security;
alter table app_private.tags enable row level security;
alter table app_private.game_tags enable row level security;
alter table app_private.contributors enable row level security;
alter table app_private.manual_contributions enable row level security;
alter table app_private.external_supported_platforms enable row level security;

drop policy if exists runtime_platforms on app_private.platforms;
create policy runtime_platforms on app_private.platforms for all to app_runtime using (true) with check (true);
drop policy if exists runtime_game_platforms on app_private.game_platforms;
create policy runtime_game_platforms on app_private.game_platforms for all to app_runtime using (true) with check (true);
drop policy if exists runtime_tags on app_private.tags;
create policy runtime_tags on app_private.tags for all to app_runtime using (true) with check (true);
drop policy if exists runtime_game_tags on app_private.game_tags;
create policy runtime_game_tags on app_private.game_tags for all to app_runtime using (true) with check (true);
drop policy if exists runtime_contributors on app_private.contributors;
create policy runtime_contributors on app_private.contributors for all to app_runtime using (true) with check (true);
drop policy if exists runtime_manual_contributions on app_private.manual_contributions;
create policy runtime_manual_contributions on app_private.manual_contributions for all to app_runtime using (true) with check (true);
drop policy if exists runtime_external_supported_platforms on app_private.external_supported_platforms;
create policy runtime_external_supported_platforms on app_private.external_supported_platforms for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

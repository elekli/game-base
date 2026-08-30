begin;

create extension if not exists pgtap with schema extensions;
select plan(8);

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;

select ok(
  (select count(*) from app_private.external_game_identities where provider = 'bgg' and source_id = '101') = 0,
  'probe identity is absent before insert'
);

insert into app_private.external_game_identities (provider, source_id, medium, snapshot)
values ('bgg', '101', 'board_game', '{}'::jsonb);

select ok(
  exists(select 1 from app_private.external_game_identities where provider = 'bgg' and source_id = '101'),
  'runtime can insert a valid source identity'
);

select extensions.throws_like(
  $$insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values ('bgg', '101', 'board_game', '{}'::jsonb)$$,
  '%duplicate key value violates unique constraint%',
  'provider and source id are globally unique'
);

select extensions.throws_like(
  $$insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values ('bgg', '102', 'video_game', '{}'::jsonb)$$,
  '%check constraint%',
  'BGG cannot be linked to a video game medium'
);

insert into app_private.games (medium, display_name, external_game_identity_id)
select 'board_game', '相同名稱', id from app_private.external_game_identities where provider = 'bgg' and source_id = '101';

select extensions.throws_like(
  $$insert into app_private.games (medium, display_name, external_game_identity_id) select 'board_game', '另一筆', id from app_private.external_game_identities where provider = 'bgg' and source_id = '101'$$,
  '%duplicate key value violates unique constraint%',
  'one source identity can link to at most one game'
);

insert into app_private.external_game_identities (provider, source_id, medium, snapshot)
values ('igdb', '202', 'video_game', '{}'::jsonb);
insert into app_private.games (medium, display_name, external_game_identity_id)
select 'video_game', '相同名稱', id from app_private.external_game_identities where provider = 'igdb' and source_id = '202';

select is(
  (select count(*)::integer from app_private.games where display_name = '相同名稱'),
  2,
  'same names from different sources remain separate games'
);

update app_private.games set trashed_at = now() where display_name = '相同名稱' and medium = 'board_game';

select ok(
  exists(select 1 from app_private.games where display_name = '相同名稱' and medium = 'board_game' and trashed_at is not null),
  'trashing a game does not release its source identity'
);

select extensions.throws_like(
  $$insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values ('bgg', '101', 'board_game', '{}'::jsonb)$$,
  '%duplicate key value violates unique constraint%',
  'trashed game still occupies provider and source id'
);

reset role;
select * from finish();
rollback;

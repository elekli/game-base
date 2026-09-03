begin;
select plan(4);
select ok(exists(select 1 from pg_constraint where conname = 'games_external_identity_medium_fk'), '遊戲與來源媒體類型有外鍵約束');
select ok(exists(select 1 from pg_constraint where conname = 'external_game_identities_id_medium_unique'), '來源身分媒體複合唯一鍵存在');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot) values ('00000000-0000-0000-0000-000000000006', 'igdb', '9601', 'video_game', '{}'::jsonb);
select extensions.throws_like($$insert into app_private.games (id, medium, display_name, external_game_identity_id) values ('00000000-0000-0000-0000-000000000007', 'board_game', '媒體不相容', '00000000-0000-0000-0000-000000000006')$$, '%violates foreign key constraint%', '資料庫拒絕跨媒體來源連結');
select ok(not exists(select 1 from app_private.games where id = '00000000-0000-0000-0000-000000000007'), '跨媒體連結失敗不留下遊戲條目');
reset role;
select * from finish();
rollback;

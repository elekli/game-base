begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
select has_column('app_private', 'command_receipts', 'owner_id', 'command receipts keep owner binding');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;

insert into app_private.games (id, medium, display_name)
values ('20000000-0000-4000-8000-000000000020', 'board_game', '資源回收測試');

insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot)
values ('24000000-0000-4000-8000-000000000020', 'bgg', '720020', 'board_game', '{"title":"來源錨點"}');
insert into app_private.games (id, medium, display_name, external_game_identity_id)
values ('21000000-0000-4000-8000-000000000020', 'board_game', '來源遊戲', '24000000-0000-4000-8000-000000000020');
insert into app_private.notes (id, game_id, content)
values ('25000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000020', '保留筆記');
insert into app_private.lists (id, name)
values ('26000000-0000-4000-8000-000000000020', '資源回收驗收清單');
insert into app_private.list_memberships (id, list_id, game_id, description)
values ('27000000-0000-4000-8000-000000000020', '26000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000020', '保留成員說明');
insert into app_private.game_relations (id, left_external_game_identity_id, right_game_id, description)
values ('28000000-0000-4000-8000-000000000020', '24000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000020', '保留關聯說明');

insert into app_private.command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256)
values
  ('21000000-0000-4000-8000-000000000020', 'owner', 'game.trash', 'game', '20000000-0000-4000-8000-000000000020', 1, repeat('a', 64)),
  ('22000000-0000-4000-8000-000000000020', 'owner', 'game.restore', 'game', '20000000-0000-4000-8000-000000000020', 2, repeat('b', 64));

select extensions.is((select count(*)::int from app_private.command_receipts where command_kind = 'game.trash'), 1, 'trash command kind is accepted');
select extensions.is((select count(*)::int from app_private.command_receipts where command_kind = 'game.restore'), 1, 'restore command kind is accepted');
select extensions.is((select owner_id from app_private.command_receipts where command_kind = 'game.trash'), 'owner', 'lifecycle receipt keeps its owner binding');
select extensions.throws_ok($$insert into app_private.command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256) values ('23000000-0000-4000-8000-000000000020', 'owner', 'game.delete', 'game', '20000000-0000-4000-8000-000000000020', 1, repeat('c', 64))$$, '23514', null, 'unsupported lifecycle command remains rejected');

update app_private.games set trashed_at = clock_timestamp(), version = version + 1 where id = '20000000-0000-4000-8000-000000000020';
select extensions.throws_ok($$insert into app_private.games (id, medium, display_name, external_game_identity_id) values ('29000000-0000-4000-8000-000000000020', 'board_game', '重複來源', '24000000-0000-4000-8000-000000000020')$$, '23505', null, 'trash does not release the unique source anchor');
select extensions.ok((select trashed_at is not null from app_private.games where id = '20000000-0000-4000-8000-000000000020'), 'trash marks the game');
select extensions.is((select version::int from app_private.games where id = '20000000-0000-4000-8000-000000000020'), 2, 'trash increments version');
select extensions.ok((select count(*) = 1 from app_private.notes where game_id = '20000000-0000-4000-8000-000000000020') and (select count(*) = 1 from app_private.list_memberships where game_id = '20000000-0000-4000-8000-000000000020') and (select count(*) = 1 from app_private.game_relations where right_game_id = '20000000-0000-4000-8000-000000000020'), 'trash retains notes, list membership, and relation rows');
update app_private.games set trashed_at = null, version = version + 1 where id = '20000000-0000-4000-8000-000000000020';
select extensions.ok((select trashed_at is null from app_private.games where id = '20000000-0000-4000-8000-000000000020'), 'restore clears the marker');
select extensions.is((select version::int from app_private.games where id = '20000000-0000-4000-8000-000000000020'), 3, 'restore increments version');
select extensions.ok((select count(*) = 1 from app_private.notes where game_id = '20000000-0000-4000-8000-000000000020') and (select count(*) = 1 from app_private.list_memberships where game_id = '20000000-0000-4000-8000-000000000020') and (select count(*) = 1 from app_private.game_relations where right_game_id = '20000000-0000-4000-8000-000000000020'), 'restore preserves the same child rows');

select extensions.ok(exists(select 1 from pg_policies where schemaname = 'app_private' and tablename = 'command_receipts' and policyname = 'runtime_command_receipts'), 'command receipt RLS policy remains installed');
reset role;
select * from finish();
rollback;

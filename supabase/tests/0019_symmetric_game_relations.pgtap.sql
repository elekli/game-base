begin;
select plan(23);

select has_table('app_private', 'game_relations', 'symmetric game relations persist as one row');
select ok((select tableowner = 'app_migrator' from pg_tables where schemaname = 'app_private' and tablename = 'game_relations'), 'migrator owns relations');
select has_pk('app_private', 'game_relations', 'relation id is stable through removal and restore');
select has_column('app_private', 'game_relations', 'version', 'relation supports optimistic concurrency');
select fk_ok('app_private', 'game_relations', 'left_game_id', 'app_private', 'games', 'id', 'left owned reference is restricted to an existing game');
select fk_ok('app_private', 'game_relations', 'right_game_id', 'app_private', 'games', 'id', 'right owned reference is restricted to an existing game');
select fk_ok('app_private', 'game_relations', 'left_external_game_identity_id', 'app_private', 'external_game_identities', 'id', 'left external reference uses stable source identity');
select fk_ok('app_private', 'game_relations', 'right_external_game_identity_id', 'app_private', 'external_game_identities', 'id', 'right external reference uses stable source identity');
select ok((select relrowsecurity from pg_class where oid = 'app_private.game_relations'::regclass), 'relations enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.game_relations', 'select,insert,update,delete'), 'runtime may manage relations');
select ok(not has_table_privilege('anon', 'app_private.game_relations', 'select,insert,update,delete'), 'anonymous role cannot access relations');
select has_table('app_private', 'relation_command_receipts', 'relation mutations retain retry outcomes');
select ok((select tableowner = 'app_migrator' from pg_tables where schemaname = 'app_private' and tablename = 'relation_command_receipts'), 'migrator owns relation receipts');
select has_pk('app_private', 'relation_command_receipts', 'command id is receipt identity');
select has_column('app_private', 'relation_command_receipts', 'expires_at', 'relation receipt retention is explicit');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
insert into app_private.games (id, medium, display_name) values
  ('20000000-0000-4000-8000-000000000019', 'board_game', '關聯測試 A'),
  ('20000000-0000-4000-8000-000000000020', 'video_game', '關聯測試 B');
insert into app_private.game_relations (id, left_game_id, right_game_id)
values ('30000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000020');
select is((select count(*)::integer from app_private.game_relations where id = '30000000-0000-4000-8000-000000000019'), 1, 'one directed insert represents the symmetric pair');
select extensions.throws_like(
  $$insert into app_private.game_relations (id, left_game_id, right_game_id) values ('30000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000019')$$,
  '%violates check constraint%',
  'reversed pair must be sorted before persistence'
);
select extensions.throws_like(
  $$insert into app_private.game_relations (id, left_game_id, right_game_id) values ('30000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000020')$$,
  '%duplicate key value violates unique constraint%',
  'a removed or active pair cannot be duplicated'
);
select extensions.throws_like(
  $$insert into app_private.game_relations (id, left_game_id, right_game_id) values ('30000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000019')$$,
  '%violates check constraint%',
  'a game cannot be related to itself'
);
select ok((select relrowsecurity from pg_class where oid = 'app_private.relation_command_receipts'::regclass), 'relation receipts enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.relation_command_receipts', 'select,insert,update,delete'), 'runtime may manage relation receipts');
select ok(not has_table_privilege('anon', 'app_private.relation_command_receipts', 'select,insert,update,delete'), 'anonymous role cannot access relation receipts');
insert into app_private.relation_command_receipts(command_id, owner_id, command_kind, payload_sha256)
values ('40000000-0000-4000-8000-000000000019', 'relation-test-owner', 'relation.add', repeat('a', 64));
select is((select count(*)::integer from app_private.relation_command_receipts where command_id = '40000000-0000-4000-8000-000000000019'), 1, 'runtime can write and read its relation receipt');

reset role;
select * from finish();
rollback;

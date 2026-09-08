begin;
select plan(18);

select has_column('app_private', 'games', 'version', 'games expose an optimistic concurrency version');
select col_default_is('app_private', 'games', 'version', '1', 'new games start at version one');
select has_table('app_private', 'command_receipts', 'command receipts persist retry outcomes');
select has_pk('app_private', 'command_receipts', 'command id is the receipt identity');
select has_column('app_private', 'command_receipts', 'owner_id', 'receipt binds owner identity');
select has_column('app_private', 'command_receipts', 'target_id', 'receipt binds target identity');
select has_column('app_private', 'command_receipts', 'expected_version', 'receipt binds expected version');
select has_column('app_private', 'command_receipts', 'payload_sha256', 'receipt stores only a payload digest');
select has_column('app_private', 'command_receipts', 'result_version', 'receipt stores replay version');
select has_column('app_private', 'command_receipts', 'result_state', 'receipt stores replay state');
select has_column('app_private', 'command_receipts', 'expires_at', 'receipt has explicit expiry');
select ok((select relrowsecurity from pg_class where oid = 'app_private.command_receipts'::regclass), 'command receipts enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.command_receipts', 'select,insert,update,delete'), 'runtime may manage receipts');
select ok(not has_table_privilege('anon', 'app_private.command_receipts', 'select,insert,update,delete'), 'anonymous role cannot access receipts');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
select extensions.throws_like(
  $$insert into app_private.games (medium, display_name, version) values ('board_game', 'null version probe', null)$$,
  '%violates check constraint%',
  'game version cannot be null'
);
insert into app_private.command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256)
values ('44444444-4444-4444-8444-444444444444', 'pgtap-owner', 'game.edit', 'game', '55555555-5555-4555-8555-555555555555', 1, repeat('a', 64));
select extensions.ok((select expires_at = created_at + interval '90 days' from app_private.command_receipts where command_id = '44444444-4444-4444-8444-444444444444'), 'receipt retention is exactly 90 days');
select extensions.throws_like(
  $$insert into app_private.command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256) values ('66666666-6666-4666-8666-666666666666', 'pgtap-owner', 'game.edit', 'game', '77777777-7777-4777-8777-777777777777', 1, 'raw payload')$$,
  '%violates check constraint%',
  'receipt rejects non-digest payload storage'
);
select extensions.throws_like(
  $$update app_private.command_receipts set result_version = 2 where command_id = '44444444-4444-4444-8444-444444444444'$$,
  '%violates check constraint%',
  'receipt result version and state must complete together'
);

reset role;
select * from finish();
rollback;

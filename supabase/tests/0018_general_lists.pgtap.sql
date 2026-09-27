begin;
select plan(27);

select has_table('app_private', 'lists', 'general lists persist after the first member is chosen');
select has_pk('app_private', 'lists', 'list id is stable identity');
select has_column('app_private', 'lists', 'version', 'list exposes optimistic concurrency version');
select has_column('app_private', 'lists', 'archived_at', 'list supports recoverable archive');
select ok((select relrowsecurity from pg_class where oid = 'app_private.lists'::regclass), 'lists enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.lists', 'select,insert,update,delete'), 'runtime may manage lists');
select ok(not has_table_privilege('anon', 'app_private.lists', 'select,insert,update,delete'), 'anonymous role cannot access lists');

select has_table('app_private', 'external_game_references', 'out-of-library members retain stable source identity metadata');
select has_pk('app_private', 'external_game_references', 'external reference is unique per source identity');
select fk_ok('app_private', 'external_game_references', 'external_game_identity_id', 'app_private', 'external_game_identities', 'id', 'external reference points to canonical source identity');
select has_column('app_private', 'external_game_references', 'version', 'external reference metadata is versioned');
select has_column('app_private', 'external_game_references', 'thumbnail_object_key', 'external reference keeps its private local thumbnail pointer');
select has_column('app_private', 'external_game_references', 'thumbnail_lease_token', 'external thumbnail processing uses a fenced lease');
select has_column('app_private', 'external_game_references', 'thumbnail_lease_until', 'external thumbnail leases expire for retry');

select has_table('app_private', 'list_memberships', 'list membership is persisted separately');
select has_pk('app_private', 'list_memberships', 'membership id survives source promotion');
select fk_ok('app_private', 'list_memberships', 'list_id', 'app_private', 'lists', 'id', 'membership belongs to a list');
select fk_ok('app_private', 'list_memberships', 'game_id', 'app_private', 'games', 'id', 'owned membership points to a game');
select fk_ok('app_private', 'list_memberships', 'external_game_identity_id', 'app_private', 'external_game_identities', 'id', 'external membership points to stable source identity');
select has_column('app_private', 'list_memberships', 'removed_at', 'membership supports recoverable removal');
select ok((select relrowsecurity from pg_class where oid = 'app_private.list_memberships'::regclass), 'memberships enable RLS');

select has_table('app_private', 'list_command_receipts', 'list command receipts persist retry outcomes');
select has_pk('app_private', 'list_command_receipts', 'command id is receipt identity');
select has_column('app_private', 'list_command_receipts', 'expires_at', 'receipt retention is explicit');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
insert into app_private.lists (id, name) values ('10000000-0000-4000-8000-000000000018', 'pgTAP 清單');
select extensions.throws_like(
  $$insert into app_private.lists (id, name) values ('10000000-0000-4000-8000-000000000019', 'PGTAP 清單')$$,
  '%duplicate key value violates unique constraint%',
  'normalized list name is unique without case distinctions'
);
insert into app_private.games (id, medium, display_name)
values ('20000000-0000-4000-8000-000000000018', 'board_game', 'pgTAP 成員');
insert into app_private.list_memberships (id, list_id, game_id)
values ('30000000-0000-4000-8000-000000000018', '10000000-0000-4000-8000-000000000018', '20000000-0000-4000-8000-000000000018');
select extensions.throws_like(
  $$insert into app_private.list_memberships (id, list_id, game_id, external_game_identity_id) values ('30000000-0000-4000-8000-000000000019', '10000000-0000-4000-8000-000000000018', '20000000-0000-4000-8000-000000000018', '40000000-0000-4000-8000-000000000018')$$,
  '%violates check constraint%',
  'membership cannot point to both an owned game and an external identity'
);
insert into app_private.list_command_receipts (command_id, owner_id, command_kind, target_id, expected_version, payload_sha256)
values ('50000000-0000-4000-8000-000000000018', 'owner', 'list.archive', '10000000-0000-4000-8000-000000000018', 1, repeat('a', 64));
select extensions.ok((select expires_at = created_at + interval '90 days' from app_private.list_command_receipts where command_id = '50000000-0000-4000-8000-000000000018'), 'list receipt retention is exactly 90 days');

reset role;
select * from finish();
rollback;

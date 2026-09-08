begin;
select plan(21);

select has_table('app_private', 'notes', 'notes persist owner-authored Markdown');
select has_pk('app_private', 'notes', 'note id is stable identity');
select has_column('app_private', 'notes', 'game_id', 'note belongs to a game');
select has_column('app_private', 'notes', 'content', 'note stores Markdown source');
select has_column('app_private', 'notes', 'version', 'note exposes optimistic concurrency version');
select has_column('app_private', 'notes', 'removed_at', 'note supports recoverable removal');
select fk_ok('app_private', 'notes', 'game_id', 'app_private', 'games', 'id', 'note game reference is enforced');
select ok((select relrowsecurity from pg_class where oid = 'app_private.notes'::regclass), 'notes enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.notes', 'select,insert,update,delete'), 'runtime may manage notes');
select ok(not has_table_privilege('anon', 'app_private.notes', 'select,insert,update,delete'), 'anonymous role cannot access notes');

select has_table('app_private', 'note_command_receipts', 'note receipts persist retry outcomes');
select has_pk('app_private', 'note_command_receipts', 'note command id is receipt identity');
select has_column('app_private', 'note_command_receipts', 'result_id', 'create replay retains generated note id');
select has_column('app_private', 'note_command_receipts', 'expires_at', 'note receipt has explicit expiry');
select ok((select relrowsecurity from pg_class where oid = 'app_private.note_command_receipts'::regclass), 'note receipts enable RLS');
select ok(has_table_privilege('app_runtime', 'app_private.note_command_receipts', 'select,insert,update,delete'), 'runtime may manage note receipts');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
insert into app_private.games (id, medium, display_name)
values ('11111111-1111-4111-8111-111111111111', 'board_game', 'note pgTAP probe');
select extensions.throws_like(
  $$insert into app_private.notes (id, game_id, content) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', E'  \n ')$$,
  '%violates check constraint%',
  'blank note content is rejected'
);
insert into app_private.notes (id, game_id, content)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '**原文**');
select extensions.throws_like(
  $$update app_private.notes set version = 0 where id = '22222222-2222-4222-8222-222222222222'$$,
  '%violates check constraint%',
  'note version must remain positive'
);
insert into app_private.note_command_receipts (command_id, owner_id, command_kind, target_kind, target_id, payload_sha256)
values ('33333333-3333-4333-8333-333333333333', 'owner', 'note.create', 'game', '11111111-1111-4111-8111-111111111111', repeat('a', 64));
select extensions.ok((select expires_at = created_at + interval '90 days' from app_private.note_command_receipts where command_id = '33333333-3333-4333-8333-333333333333'), 'note receipt retention is exactly 90 days');
insert into app_private.note_command_receipts (command_id, owner_id, command_kind, target_kind, target_id, payload_sha256)
select gen_random_uuid(), 'owner', 'note.create', 'game', '11111111-1111-4111-8111-111111111111', repeat('c', 64) from generate_series(1, 100);
select extensions.ok((select bool_and(expires_at = created_at + interval '90 days') from app_private.note_command_receipts), 'consecutive receipts share one stable clock per row');
select extensions.throws_like(
  $$insert into app_private.note_command_receipts (command_id, owner_id, command_kind, target_kind, target_id, payload_sha256) values ('44444444-4444-4444-8444-444444444444', 'owner', 'note.update', 'game', '11111111-1111-4111-8111-111111111111', repeat('b', 64))$$,
  '%violates check constraint%',
  'non-create note commands require a note target and expected version'
);

reset role;
select * from finish();
rollback;

begin;
select plan(28);

select has_table('app_private', 'production_product_canaries', 'product canary has a private registry');
select has_column('app_private', 'games', 'is_production_canary', 'canary games have a hidden marker');
select has_column('app_private', 'lists', 'production_canary_generation', 'canary lists retain their generation');
select ok(not has_table_privilege('app_runtime', 'app_private.production_product_canaries', 'SELECT'), 'runtime cannot read registry directly');
select ok(not has_table_privilege('app_runtime', 'app_private.production_product_canaries', 'INSERT'), 'runtime cannot insert registry rows directly');
select ok(not has_table_privilege('app_runtime', 'app_private.production_product_canaries', 'UPDATE'), 'runtime cannot update registry rows directly');
select ok(not has_table_privilege('app_runtime', 'app_private.production_product_canaries', 'DELETE'), 'runtime cannot delete registry rows directly');
select ok(not has_function_privilege('app_runtime', 'app_private.claim_production_product_canary(uuid,text)', 'EXECUTE'), 'runtime cannot claim a canary generation');
select ok(has_function_privilege('postgres', 'app_private.claim_production_product_canary(uuid,text)', 'EXECUTE'), 'protected database runner can claim a canary generation');
select ok(has_function_privilege('app_runtime', 'app_private.list_production_product_canary_games(uuid,text)', 'EXECUTE'), 'runtime can read only the active owner fixture through a fixed function');
select ok(not has_function_privilege('app_runtime', 'app_private.guard_current_production_product_canary_command()', 'EXECUTE'), 'runtime cannot invoke the trigger-only guard directly');

select is(
  app_private.claim_production_product_canary('11111111-1111-4111-8111-111111111111', 'pgtap-owner'),
  true,
  'claim creates the fixed synthetic games'
);
select is((select count(*)::integer from app_private.games where is_production_canary), 2, 'claim inserts exactly two canary games');
select is((select count(*)::integer from app_private.list_production_product_canary_games('11111111-1111-4111-8111-111111111111', 'pgtap-owner')), 2, 'registered owner sees both fixed canary games');
select is((select count(*)::integer from app_private.list_production_product_canary_games('11111111-1111-4111-8111-111111111111', 'other-owner')), 0, 'another owner cannot enumerate the fixture');
select is(
  app_private.begin_production_product_canary_command(
    '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '33333333-3333-4333-8333-333333333333', 'relation.add',
    array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid, 'c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c'::uuid]
  ),
  true,
  'fixed relation accepts the exact two canary games'
);
select is(
  app_private.complete_production_product_canary_command('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'),
  true,
  'relation command returns the canary to active phase'
);
select throws_ok(
  $$insert into app_private.lists(id, name, is_production_canary) values ('44444444-4444-4444-8444-444444444444', 'unclaimed canary', true)$$,
  'P0001',
  'canary_list_write_rejected',
  'runtime writes cannot forge the canary list marker outside a list command'
);
select is(
  app_private.begin_production_product_canary_command(
    '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '55555555-5555-4555-8555-555555555555', 'list.create', array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid]
  ),
  true,
  'fixed list command starts'
);
select app_private.guard_production_product_canary_command(
  '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '55555555-5555-4555-8555-555555555555', 'list.create', array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid]
);
insert into app_private.lists(id, name) values ('66666666-6666-4666-8666-666666666666', 'protected canary list');
select throws_ok(
  $$update app_private.lists set is_production_canary = false where id = '66666666-6666-4666-8666-666666666666'::uuid$$,
  'P0001',
  'canary_list_write_rejected',
  'canary list writes cannot clear the marker and escape cleanup'
);
select is(
  app_private.complete_production_product_canary_command('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555'),
  true,
  'list create command returns the canary to active phase'
);
select throws_ok(
  $$select app_private.begin_production_product_canary_command(
    '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '22222222-2222-4222-8222-222222222222', 'game.trash', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid]
  )$$,
  'P0001',
  'canary target is not fixed',
  'unknown targets are refused before a product request starts'
);
select is(
  app_private.begin_production_product_canary_command(
    '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '22222222-2222-4222-8222-222222222222', 'game.trash', array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid]
  ),
  true,
  'fixed target command starts'
);
select throws_ok(
  $$update app_private.games set trashed_at = clock_timestamp() where id = '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid$$,
  'P0001',
  'canary_command_rejected',
  'product writes require the same-transaction generation guard'
);
select app_private.guard_production_product_canary_command(
  '11111111-1111-4111-8111-111111111111', 'pgtap-owner', '22222222-2222-4222-8222-222222222222',
  'game.trash', array['21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid]
);
select throws_ok(
  $$update app_private.games set display_name = 'unexpected' , trashed_at = clock_timestamp() where id = '21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d'::uuid$$,
  'P0001',
  'canary_game_write_rejected',
  'trash commands cannot modify other game fields'
);
select throws_ok(
  $$select app_private.prepare_production_product_canary_cleanup('11111111-1111-4111-8111-111111111111')$$,
  'P0001',
  'canary_command_requires_recovery',
  'pending commands must be durably marked for recovery before cleanup'
);
select is(
  app_private.require_production_product_canary_recovery('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
  false,
  'unexpired commands cannot enter recovery or cleanup'
);
select is(
  (select phase from app_private.production_product_canaries where generation = '11111111-1111-4111-8111-111111111111'),
  'request_pending',
  'unexpired command remains pending after recovery is refused'
);
select * from finish();
rollback;

begin;
select plan(75);

select has_table('app_private', 'production_smoke_canaries', 'production smoke canary persistence exists');
select has_column('app_private', 'production_smoke_canaries', 'id', 'canary has fixed row id');
select has_column('app_private', 'production_smoke_canaries', 'identity', 'canary stores stable identity');
select has_column('app_private', 'production_smoke_canaries', 'generation', 'canary stores attempt generation');
select has_column('app_private', 'production_smoke_canaries', 'action_sequence', 'canary stores the mutation fence');
select has_column('app_private', 'production_smoke_canaries', 'payload_sha256', 'canary stores payload fingerprint');
select has_column('app_private', 'production_smoke_canaries', 'phase', 'canary stores persisted phase');
select has_column('app_private', 'production_smoke_canaries', 'created_at', 'canary stores creation time');
select has_column('app_private', 'production_smoke_canaries', 'updated_at', 'canary stores update time');
select has_pk('app_private', 'production_smoke_canaries', 'fixed canary row has a primary key');

select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.production_smoke_canaries'::regclass),
  'canary table enables RLS'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'app_private.production_smoke_canaries'::regclass),
  'canary table forces RLS for its owner'
);

select ok(
  not has_table_privilege(role_name, 'app_private.production_smoke_canaries', 'select,insert,update,delete'),
  role_name || ' has no direct canary table CRUD'
)
from unnest(array['app_runtime', 'anon', 'authenticated', 'service_role']) role_name;
select ok(
  not exists (
    select 1
    from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where acl.grantee = 0 and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  'PUBLIC has no direct canary table CRUD'
)
from pg_class c
where c.oid = 'app_private.production_smoke_canaries'::regclass;

select ok(to_regprocedure(signature) is not null, signature || ' exists')
from unnest(array[
  'app_private.inspect_production_smoke_canary()',
  'app_private.claim_production_smoke_canary(text,text,text,bigint)',
  'app_private.transition_production_smoke_canary(text,text,text,bigint,text,bigint,text)',
  'app_private.cleanup_production_smoke_canary(text,text,text,bigint,text)'
]) signature;

select ok(has_function_privilege('app_runtime', signature, 'execute'), 'app_runtime may execute ' || signature)
from unnest(array[
  'app_private.inspect_production_smoke_canary()',
  'app_private.claim_production_smoke_canary(text,text,text,bigint)',
  'app_private.transition_production_smoke_canary(text,text,text,bigint,text,bigint,text)',
  'app_private.cleanup_production_smoke_canary(text,text,text,bigint,text)'
]) signature;

select ok(not has_function_privilege(role_name, signature, 'execute'), role_name || ' may not execute ' || signature)
from unnest(array['anon', 'authenticated', 'service_role']) role_name
cross join unnest(array[
  'app_private.inspect_production_smoke_canary()',
  'app_private.claim_production_smoke_canary(text,text,text,bigint)',
  'app_private.transition_production_smoke_canary(text,text,text,bigint,text,bigint,text)',
  'app_private.cleanup_production_smoke_canary(text,text,text,bigint,text)'
]) signature;

select ok(
  not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = to_regprocedure(signature)
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC may not execute ' || signature
)
from unnest(array[
  'app_private.inspect_production_smoke_canary()',
  'app_private.claim_production_smoke_canary(text,text,text,bigint)',
  'app_private.transition_production_smoke_canary(text,text,text,bigint,text,bigint,text)',
  'app_private.cleanup_production_smoke_canary(text,text,text,bigint,text)'
]) signature;

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;

select is((select row_count from app_private.inspect_production_smoke_canary()), 0::bigint, 'inspect starts at bounded 0 rows');
select extensions.throws_like(
  $$select app_private.claim_production_smoke_canary('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 3)$$,
  '%generation must be canonical UUIDv4%',
  'claim rejects a non-canonical generation'
);
select extensions.throws_like(
  $$select app_private.claim_production_smoke_canary(null, 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 3)$$,
  '%generation must be canonical UUIDv4%',
  'claim rejects a missing generation with a named error'
);
select ok(
  app_private.claim_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111',
    'release-smoke-v1:' || repeat('a', 40),
    repeat('b', 64),
    3
  ),
  'empty fixed slot can be claimed atomically'
);
select is((select row_count from app_private.inspect_production_smoke_canary()), 1::bigint, 'inspect is bounded at one row');
select is((select identity from app_private.inspect_production_smoke_canary()), 'release-smoke-v1:' || repeat('a', 40), 'inspect returns identity');
select is((select generation from app_private.inspect_production_smoke_canary()), '11111111-1111-4111-8111-111111111111', 'inspect returns generation');
select is((select action_sequence from app_private.inspect_production_smoke_canary()), 3::bigint, 'inspect returns action sequence');
select is((select payload_sha256 from app_private.inspect_production_smoke_canary()), repeat('b', 64), 'inspect returns payload hash');
select is((select phase from app_private.inspect_production_smoke_canary()), 'row_claimed', 'claim starts at row_claimed');
select ok(
  not app_private.claim_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111',
    'release-smoke-v1:' || repeat('a', 40),
    repeat('b', 64),
    3
  ),
  'an occupied fixed slot cannot be claimed twice'
);
select extensions.throws_like(
  $$select app_private.transition_production_smoke_canary('11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 3, 'row_claimed', 4, 'object_written')$$,
  '%persisted phase transition is not allowed%',
  'transition rejects skipped phases'
);
select ok(
  app_private.transition_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    3, 'row_claimed', 4, 'object_write_pending'
  ),
  'claim advances by exact compare-and-swap'
);
select ok(
  not app_private.transition_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    4, 'object_write_pending', 4, 'object_written'
  ),
  'another generation cannot advance the row'
);
select ok(
  app_private.transition_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    4, 'object_write_pending', 4, 'object_written'
  ),
  'confirmed object write advances to object_written'
);
select ok(
  app_private.transition_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    4, 'object_written', 6, 'cleanup_pending'
  ),
  'verified round trip advances to cleanup_pending'
);
select ok(
  not app_private.cleanup_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 6, 'cleanup_pending'
  ),
  'another generation cannot clean the row'
);
select ok(
  app_private.cleanup_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 6, 'cleanup_pending'
  ),
  'exact cleanup deletes the fixed row'
);
select is((select row_count from app_private.inspect_production_smoke_canary()), 0::bigint, 'cleanup restores the 0-row bound');
select ok(
  app_private.claim_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 10
  ),
  'a later generation may claim the empty slot'
);
select ok(
  not app_private.cleanup_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 6, 'row_claimed'
  ),
  'an old generation cannot clean the later claim'
);
select is((select generation from app_private.inspect_production_smoke_canary()), '22222222-2222-4222-8222-222222222222', 'later claim survives stale cleanup');
select ok(
  not app_private.transition_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    3, 'row_claimed', 4, 'object_write_pending'
  ),
  'an old generation cannot transition the later claim'
);
select ok(
  app_private.cleanup_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 10, 'row_claimed'
  ),
  'the later claim can be cleaned by its exact action sequence'
);
select ok(
  app_private.claim_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 12
  ),
  'the same generation may reclaim the empty slot with a later action sequence'
);
select ok(
  not app_private.cleanup_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 10, 'row_claimed'
  ),
  'a late cleanup cannot delete a same-generation re-claim'
);
select is((select action_sequence from app_private.inspect_production_smoke_canary()), 12::bigint, 'same-generation re-claim survives stale cleanup');
select ok(
  not app_private.transition_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    10, 'row_claimed', 13, 'object_write_pending'
  ),
  'a stale same-generation action cannot transition the re-claim'
);
select ok(
  app_private.transition_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    12, 'row_claimed', 13, 'object_write_pending'
  ),
  'the current action sequence advances the re-claim to write pending'
);
select ok(
  app_private.transition_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64),
    13, 'object_write_pending', 13, 'cleanup_pending'
  ),
  'confirmed absent object moves write pending to deterministic cleanup'
);
select ok(
  not app_private.cleanup_production_smoke_canary(
    '11111111-1111-4111-8111-111111111111', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 13, 'cleanup_pending'
  ),
  'a wrong generation cannot clean a confirmed-absent write'
);
select ok(
  app_private.cleanup_production_smoke_canary(
    '22222222-2222-4222-8222-222222222222', 'release-smoke-v1:' || repeat('a', 40), repeat('b', 64), 13, 'cleanup_pending'
  ),
  'confirmed-absent write cleanup deletes the exact row'
);
select extensions.throws_like(
  $$select * from app_private.production_smoke_canaries$$,
  '%permission denied%',
  'runtime cannot bypass functions with direct SELECT'
);
select extensions.throws_like(
  $$insert into app_private.production_smoke_canaries (id, identity, generation, payload_sha256, phase) values ('7355773e-c3b5-4e5d-9f07-55ac0e22f384', 'release-smoke-v1:' || repeat('a', 40), '33333333-3333-4333-8333-333333333333', repeat('b', 64), 'row_claimed')$$,
  '%permission denied%',
  'runtime cannot bypass functions with direct INSERT'
);

reset role;
select * from finish();
rollback;

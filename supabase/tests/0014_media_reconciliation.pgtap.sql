begin;
select plan(9);

select has_table('app_private', 'media_reconciliation_runs', '每日 reconcile run 狀態帳存在');
select has_table('app_private', 'media_cleanup_jobs', '可重試 cleanup job 狀態帳存在');
select has_column('app_private', 'media_cleanup_jobs', 'attempt_id', 'cleanup job 保留 immutable attempt 引用');
select has_column('app_private', 'media_cleanup_jobs', 'lease_token', 'cleanup job 具備 lease fencing token');
select has_index('app_private', 'media_cleanup_jobs', 'media_cleanup_jobs_claim_candidates_idx', 'cleanup claim index 涵蓋 pending／failed 與 expired processing lease');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;

select extensions.throws_like(
  $$insert into app_private.media_reconciliation_runs (local_date, state) values ('2026-09-07', 'processing')$$,
  '%media_reconciliation_runs_check%',
  'processing reconcile run 必須同時保存 lease token 與期限'
);
select extensions.throws_like(
  $$insert into app_private.media_cleanup_jobs (attempt_id) values (gen_random_uuid())$$,
  '%violates foreign key constraint%',
  'cleanup 不可憑 Storage path 建立 job，必須引用 attempt ledger'
);

select ok(has_table_privilege('app_runtime', 'app_private.media_reconciliation_runs', 'select,insert,update'), 'runtime 只經 RLS policy 使用 reconcile 狀態帳');
select ok(not has_table_privilege('anon', 'app_private.media_cleanup_jobs', 'select'), 'anon 不可讀 cleanup 狀態帳');

reset role;
select * from finish();
rollback;

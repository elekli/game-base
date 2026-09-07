begin;
select plan(8);

select has_column('app_private', 'media_derivatives', 'retry_cycle', '手動 retry 的週期獨立於總 attempt');
select has_column('app_private', 'media_derivatives', 'cycle_attempt_count', '自動週期有三次上限帳');
select has_column('app_private', 'media_derivatives', 'active_attempt_id', 'processing lease 綁定 active attempt');
select has_column('app_private', 'media_derivatives', 'adopted_attempt_id', 'ready pointer 綁定 adopted attempt');
select has_column('app_private', 'media_derivative_attempts', 'retry_cycle', '每個 attempt 記錄所屬 retry cycle');
select has_index('app_private', 'media_derivatives', 'media_derivatives_thumbnail_claim_candidates_idx', 'pending／lease claim 有候選索引');
select ok(has_function_privilege('app_runtime', 'app_private.prevent_media_derivative_attempt_delete()', 'execute') = false, 'runtime 不可直接執行 attempt delete trigger function');
select ok((
  select exists(
    select 1 from pg_trigger
    where tgrelid = 'app_private.media_derivative_attempts'::regclass
      and tgname = 'media_derivative_attempts_prevent_delete'
  )
), 'attempt ledger 不可刪除 trigger 存在');

select * from finish();
rollback;

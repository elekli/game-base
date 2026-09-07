grant app_migrator to postgres;
set local role app_migrator;

create table app_private.media_reconciliation_runs (
  local_date date primary key,
  state text not null check (state in ('processing', 'completed')),
  lease_token uuid,
  lease_until timestamptz,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((state = 'processing') = (lease_token is not null and lease_until is not null)),
  check ((state = 'completed') = (completed_at is not null))
);

create table app_private.media_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references app_private.media_derivative_attempts(id) on delete restrict,
  state text not null default 'pending' check (state in ('pending', 'processing', 'cleaned', 'failed')),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((state = 'processing') = (lease_token is not null and lease_until is not null)),
  check ((state = 'cleaned') = (completed_at is not null))
);

create index media_cleanup_jobs_claim_candidates_idx
  on app_private.media_cleanup_jobs (state, lease_until, created_at)
  where state in ('pending', 'failed', 'processing');

create function app_private.assert_media_cleanup_job()
returns trigger language plpgsql as $$
begin
  perform 1 from app_private.media_derivative_attempts attempt where attempt.id = new.attempt_id for update;
  if not exists (
    select 1 from app_private.media_derivative_attempts attempt
    where attempt.id = new.attempt_id
      and ((new.state = 'cleaned' and attempt.state = 'cleaned') or (new.state <> 'cleaned' and attempt.state = 'cleanup_pending'))
  ) then
    raise exception 'media cleanup job must match immutable attempt ledger state';
  end if;
  return new;
end;
$$;

create constraint trigger media_cleanup_jobs_match_attempt_ledger
after insert or update on app_private.media_cleanup_jobs
deferrable initially deferred for each row execute function app_private.assert_media_cleanup_job();

alter table app_private.media_reconciliation_runs enable row level security;
alter table app_private.media_cleanup_jobs enable row level security;
create policy runtime_media_reconciliation_runs on app_private.media_reconciliation_runs for all to app_runtime using (true) with check (true);
create policy runtime_media_cleanup_jobs on app_private.media_cleanup_jobs for all to app_runtime using (true) with check (true);

revoke execute on function app_private.assert_media_cleanup_job() from public, anon, authenticated, service_role;

reset role;
revoke app_migrator from postgres;

grant app_migrator to postgres;
set local role app_migrator;

create table app_private.production_smoke_canaries (
  id uuid primary key,
  identity text not null,
  generation text not null,
  action_sequence bigint not null,
  payload_sha256 text not null,
  phase text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint production_smoke_canaries_fixed_id
    check (id = '7355773e-c3b5-4e5d-9f07-55ac0e22f384'::uuid),
  constraint production_smoke_canaries_identity_format
    check (identity ~ '^release-smoke-v1:[0-9a-f]{40}$'),
  constraint production_smoke_canaries_generation_format
    check (generation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  constraint production_smoke_canaries_action_sequence_range
    check (action_sequence between 0 and 9007199254740991),
  constraint production_smoke_canaries_payload_sha256_format
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint production_smoke_canaries_phase
    check (phase in (
      'row_claimed',
      'object_write_pending',
      'object_written',
      'object_write_uncertain',
      'cleanup_pending',
      'cleanup_uncertain'
    ))
);

alter table app_private.production_smoke_canaries enable row level security;
alter table app_private.production_smoke_canaries force row level security;

create policy migrator_production_smoke_canaries_all
  on app_private.production_smoke_canaries
  for all
  to app_migrator
  using (true)
  with check (true);

revoke all on app_private.production_smoke_canaries
  from public, anon, authenticated, service_role, app_runtime;

create function app_private.inspect_production_smoke_canary()
returns table (
  row_count bigint,
  identity text,
  generation text,
  action_sequence bigint,
  payload_sha256 text,
  phase text
)
language sql
stable
security definer
set search_path = pg_catalog, app_private
as $$
  select
    count(*)::bigint,
    max(canary.identity),
    max(canary.generation),
    max(canary.action_sequence),
    max(canary.payload_sha256),
    max(canary.phase)
  from app_private.production_smoke_canaries canary
  where canary.id = '7355773e-c3b5-4e5d-9f07-55ac0e22f384'::uuid;
$$;

create function app_private.claim_production_smoke_canary(
  text,
  text,
  text,
  bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  requested_generation alias for $1;
  requested_identity alias for $2;
  requested_payload_sha256 alias for $3;
  requested_action_sequence alias for $4;
begin
  if requested_generation is null or requested_generation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'generation must be canonical UUIDv4';
  end if;
  if requested_identity is null or requested_identity !~ '^release-smoke-v1:[0-9a-f]{40}$' then
    raise exception 'identity must be canonical release smoke identity';
  end if;
  if requested_payload_sha256 is null or requested_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'payload hash must be canonical SHA-256';
  end if;
  if requested_action_sequence is null or requested_action_sequence < 0 or requested_action_sequence > 9007199254740991 then
    raise exception 'action sequence must be a non-negative safe integer';
  end if;

  insert into app_private.production_smoke_canaries (
    id,
    identity,
    generation,
    action_sequence,
    payload_sha256,
    phase
  ) values (
    '7355773e-c3b5-4e5d-9f07-55ac0e22f384'::uuid,
    requested_identity,
    requested_generation,
    requested_action_sequence,
    requested_payload_sha256,
    'row_claimed'
  );

  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create function app_private.transition_production_smoke_canary(
  text,
  text,
  text,
  bigint,
  text,
  bigint,
  text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  expected_generation alias for $1;
  expected_identity alias for $2;
  expected_payload_sha256 alias for $3;
  expected_action_sequence alias for $4;
  expected_phase alias for $5;
  next_action_sequence alias for $6;
  next_phase alias for $7;
  affected_rows integer;
begin
  if expected_generation is null or expected_generation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'generation must be canonical UUIDv4';
  end if;
  if expected_identity is null or expected_identity !~ '^release-smoke-v1:[0-9a-f]{40}$' then
    raise exception 'identity must be canonical release smoke identity';
  end if;
  if expected_payload_sha256 is null or expected_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'payload hash must be canonical SHA-256';
  end if;
  if expected_action_sequence is null or expected_action_sequence < 0 or expected_action_sequence > 9007199254740991 then
    raise exception 'expected action sequence must be a non-negative safe integer';
  end if;
  if next_action_sequence is null or next_action_sequence < expected_action_sequence or next_action_sequence > 9007199254740991 then
    raise exception 'next action sequence must be a non-decreasing safe integer';
  end if;
  if not (
    (expected_phase = 'row_claimed' and next_phase = 'object_write_pending') or
    (expected_phase = 'object_write_pending' and next_phase in ('object_written', 'object_write_uncertain', 'cleanup_pending')) or
    (expected_phase = 'object_written' and next_phase = 'cleanup_pending') or
    (expected_phase = 'cleanup_pending' and next_phase = 'cleanup_uncertain')
  ) then
    raise exception 'persisted phase transition is not allowed';
  end if;

  update app_private.production_smoke_canaries canary
  set phase = next_phase,
      action_sequence = next_action_sequence,
      updated_at = clock_timestamp()
  where canary.id = '7355773e-c3b5-4e5d-9f07-55ac0e22f384'::uuid
    and canary.generation = expected_generation
    and canary.identity = expected_identity
    and canary.payload_sha256 = expected_payload_sha256
    and canary.action_sequence = expected_action_sequence
    and canary.phase = expected_phase;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create function app_private.cleanup_production_smoke_canary(
  text,
  text,
  text,
  bigint,
  text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app_private
as $$
declare
  expected_generation alias for $1;
  expected_identity alias for $2;
  expected_payload_sha256 alias for $3;
  expected_action_sequence alias for $4;
  expected_phase alias for $5;
  affected_rows integer;
begin
  if expected_generation is null or expected_generation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'generation must be canonical UUIDv4';
  end if;
  if expected_identity is null or expected_identity !~ '^release-smoke-v1:[0-9a-f]{40}$' then
    raise exception 'identity must be canonical release smoke identity';
  end if;
  if expected_payload_sha256 is null or expected_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'payload hash must be canonical SHA-256';
  end if;
  if expected_action_sequence is null or expected_action_sequence < 0 or expected_action_sequence > 9007199254740991 then
    raise exception 'expected action sequence must be a non-negative safe integer';
  end if;
  if expected_phase not in ('row_claimed', 'cleanup_pending') then
    raise exception 'persisted phase is not eligible for cleanup';
  end if;

  delete from app_private.production_smoke_canaries canary
  where canary.id = '7355773e-c3b5-4e5d-9f07-55ac0e22f384'::uuid
    and canary.generation = expected_generation
    and canary.identity = expected_identity
    and canary.payload_sha256 = expected_payload_sha256
    and canary.action_sequence = expected_action_sequence
    and canary.phase = expected_phase;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

grant execute on function app_private.inspect_production_smoke_canary() to app_runtime;
grant execute on function app_private.claim_production_smoke_canary(text, text, text, bigint) to app_runtime;
grant execute on function app_private.transition_production_smoke_canary(text, text, text, bigint, text, bigint, text) to app_runtime;
grant execute on function app_private.cleanup_production_smoke_canary(text, text, text, bigint, text) to app_runtime;

revoke execute on function app_private.inspect_production_smoke_canary()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.claim_production_smoke_canary(text, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.transition_production_smoke_canary(text, text, text, bigint, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.cleanup_production_smoke_canary(text, text, text, bigint, text)
  from public, anon, authenticated, service_role;

reset role;
revoke app_migrator from postgres;

grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.media_derivatives
  add column retry_cycle integer default 1 check (retry_cycle > 0),
  add column cycle_attempt_count integer default 0 check (cycle_attempt_count between 0 and 3),
  add column active_attempt_id uuid,
  add column adopted_attempt_id uuid;

alter table app_private.media_derivative_attempts
  add column retry_cycle integer default 1 check (retry_cycle > 0);

create index media_derivatives_thumbnail_claim_candidates_idx
  on app_private.media_derivatives (state, next_attempt_at, lease_until)
  where authority_state = 'verified' and spec = 'thumb_webp_v1';

create or replace function app_private.assert_image_media_derivative()
returns trigger language plpgsql as $$
begin
  perform 1 from app_private.media_assets where id = new.asset_id for update;
  if new.authority_state is null or new.authority_state not in ('legacy_unverified', 'verified') then
    raise exception 'media derivative has invalid authority state';
  end if;
  if new.authority_state = 'verified' and new.spec is distinct from 'thumb_webp_v1' then
    raise exception 'verified media derivative must use thumb_webp_v1 spec';
  end if;
  if new.authority_state = 'verified' and not exists (
    select 1 from app_private.media_assets asset
    where asset.id = new.asset_id and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
  ) then
    raise exception 'media attachment cannot have a derivative';
  end if;
  if new.authority_state = 'verified' and (
    new.state not in ('pending', 'processing', 'ready', 'failed') or
    new.attempt_count is null or new.attempt_count < 0 or
    new.retry_cycle is null or new.retry_cycle <= 0 or
    new.cycle_attempt_count is null or new.cycle_attempt_count not between 0 and 3 or
    new.object_key is null or
    not (
      (new.state = 'processing' and new.lease_token is not null and new.lease_until is not null and new.active_attempt_id is not null) or
      (new.state <> 'processing' and new.lease_token is null and new.lease_until is null and new.active_attempt_id is null)
    ) or
    (new.state = 'ready' and (
      new.current_object_path is null or new.object_key is distinct from new.current_object_path or
      new.width is null or new.height is null or new.byte_size is null or new.width <= 0 or new.height <= 0 or new.byte_size <= 0 or
      new.completed_at is null or new.adopted_attempt_id is null or not exists (
        select 1 from app_private.media_derivative_attempts attempt
        where attempt.id = new.adopted_attempt_id and attempt.derivative_id = new.id
          and attempt.state = 'adopted' and attempt.object_path = new.current_object_path
          and attempt.attempt_number = new.attempt_count and attempt.retry_cycle = new.retry_cycle
      )
    )) or
    (new.state <> 'ready' and (
      new.current_object_path is not null or new.width is not null or new.height is not null or new.byte_size is not null or
      new.completed_at is not null or new.adopted_attempt_id is not null
    )) or
    (new.state = 'processing' and not exists (
      select 1 from app_private.media_derivative_attempts attempt
      where attempt.id = new.active_attempt_id and attempt.derivative_id = new.id
        and attempt.state in ('reserved', 'uploaded') and attempt.attempt_number = new.attempt_count
        and attempt.retry_cycle = new.retry_cycle
    ))
  ) then
    raise exception 'verified media derivative violates thumbnail lease ledger';
  end if;
  return new;
end;
$$;

create function app_private.protect_media_derivative_attempt()
returns trigger language plpgsql as $$
declare
  derivative_retry_cycle integer;
  derivative_attempt_count integer;
  locked_derivative_state text;
  locked_active_attempt_id uuid;
  locked_derivative_attempt_count integer;
  locked_derivative_retry_cycle integer;
  locked_lease_token uuid;
  locked_lease_until timestamptz;
begin
  if tg_op = 'INSERT' then
    select derivative.retry_cycle, derivative.attempt_count
    into derivative_retry_cycle, derivative_attempt_count
    from app_private.media_derivatives derivative
    where derivative.id = new.derivative_id and derivative.authority_state = 'verified'
    for update;
    if found and (
      new.retry_cycle is null or new.retry_cycle <= 0 or derivative_retry_cycle is null or
      new.retry_cycle is distinct from derivative_retry_cycle
    ) then
      raise exception 'media derivative attempt retry cycle must match derivative';
    end if;
    if found and (new.state <> 'reserved' or new.attempt_number <> derivative_attempt_count + 1) then
      raise exception 'media derivative attempt must be reserved next attempt';
    end if;
    if new.uploaded_at is not null or new.cleaned_at is not null then
      raise exception 'media derivative attempt timestamps violate state';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or
     new.derivative_id is distinct from old.derivative_id or
     new.attempt_number is distinct from old.attempt_number or
     new.retry_cycle is distinct from old.retry_cycle or
     new.object_path is distinct from old.object_path or
     new.created_at is distinct from old.created_at then
    raise exception 'media derivative attempt identity is immutable';
  end if;
  if not (
    (old.state = 'reserved' and new.state in ('reserved', 'uploaded', 'cleanup_pending')) or
    (old.state = 'uploaded' and new.state in ('uploaded', 'adopted', 'cleanup_pending')) or
    (old.state = 'adopted' and new.state = 'adopted') or
    (old.state = 'cleanup_pending' and new.state in ('cleanup_pending', 'cleaned')) or
    (old.state = 'cleaned' and new.state = 'cleaned')
  ) then
    raise exception 'media derivative attempt state transition is invalid';
  end if;
  if (old.state = 'reserved' and new.state = 'uploaded') or
     (old.state = 'uploaded' and new.state = 'adopted') then
    select derivative.state, derivative.active_attempt_id, derivative.attempt_count,
           derivative.retry_cycle, derivative.lease_token, derivative.lease_until
    into locked_derivative_state, locked_active_attempt_id, locked_derivative_attempt_count,
         locked_derivative_retry_cycle, locked_lease_token, locked_lease_until
    from app_private.media_derivatives derivative
    where derivative.id = old.derivative_id and derivative.authority_state = 'verified'
    for update;
    if not found or locked_derivative_state <> 'processing' or
       locked_active_attempt_id is distinct from old.id or
       locked_derivative_attempt_count is distinct from old.attempt_number or
       locked_derivative_retry_cycle is distinct from old.retry_cycle or
       locked_lease_token is null or locked_lease_until is null or
       locked_lease_until <= clock_timestamp() then
      raise exception 'media derivative attempt transition requires active lease';
    end if;
  end if;
  if (
    new.uploaded_at is distinct from old.uploaded_at and not (
      old.state = 'reserved' and new.state = 'uploaded' and
      old.uploaded_at is null and new.uploaded_at is not null
    )
  ) or (
    new.cleaned_at is distinct from old.cleaned_at and not (
      old.state = 'cleanup_pending' and new.state = 'cleaned' and
      old.cleaned_at is null and new.cleaned_at is not null
    )
  ) or (
    new.state = 'reserved' and (new.uploaded_at is not null or new.cleaned_at is not null)
  ) or (
    new.state in ('uploaded', 'adopted') and (new.uploaded_at is null or new.cleaned_at is not null)
  ) or (
    new.state = 'cleanup_pending' and new.cleaned_at is not null
  ) or (
    new.state = 'cleaned' and new.cleaned_at is null
  ) then
    raise exception 'media derivative attempt timestamps violate state';
  end if;
  if exists (
    select 1 from app_private.media_derivatives derivative
    where derivative.active_attempt_id = old.id
      and new.state not in ('reserved', 'uploaded', 'adopted')
  ) then
    raise exception 'active media derivative attempt cannot be cleaned';
  end if;
  if exists (
    select 1 from app_private.media_derivatives derivative
    where derivative.adopted_attempt_id = old.id
      and new.state <> 'adopted'
  ) then
    raise exception 'adopted media derivative attempt is immutable';
  end if;
  return new;
end;
$$;

create trigger media_derivative_attempts_protect_ledger
before insert or update on app_private.media_derivative_attempts
for each row execute function app_private.protect_media_derivative_attempt();

create function app_private.protect_verified_thumbnail_derivative_transition()
returns trigger language plpgsql as $$
begin
  if old.authority_state <> 'verified' then
    return new;
  end if;
  if old.state = 'pending' and new.state = 'processing' then
    if new.attempt_count <> old.attempt_count + 1 or
       new.cycle_attempt_count <> old.cycle_attempt_count + 1 or
       new.retry_cycle is distinct from old.retry_cycle or
       (old.next_attempt_at is not null and old.next_attempt_at > clock_timestamp()) then
      raise exception 'verified thumbnail derivative claim transition is invalid';
    end if;
  elsif old.state = 'processing' and new.state = 'processing' then
    if new.attempt_count is distinct from old.attempt_count or
       new.cycle_attempt_count is distinct from old.cycle_attempt_count or
       new.lease_token is distinct from old.lease_token or
       new.lease_until is distinct from old.lease_until then
      if old.lease_until is null or old.lease_until > clock_timestamp() or
         new.attempt_count <> old.attempt_count + 1 or
         new.cycle_attempt_count <> old.cycle_attempt_count + 1 or
         new.retry_cycle is distinct from old.retry_cycle or
         new.lease_until is null or new.lease_until <= clock_timestamp() then
        raise exception 'verified thumbnail derivative claim transition is invalid';
      end if;
    elsif new.retry_cycle is distinct from old.retry_cycle then
      raise exception 'verified thumbnail derivative claim transition is invalid';
    end if;
  elsif old.state = 'processing' and new.state in ('pending', 'failed', 'ready') then
    if new.state = 'failed' and old.lease_until is not null and old.lease_until <= clock_timestamp() and
       old.cycle_attempt_count = 3 and new.cycle_attempt_count = 3 and
       new.attempt_count is not distinct from old.attempt_count and
       new.retry_cycle is not distinct from old.retry_cycle and
       new.active_attempt_id is null and new.lease_token is null and new.lease_until is null and
       new.next_attempt_at is null and new.last_error_code = 'media_thumbnail_retry_exhausted' then
      return new;
    end if;
    if old.lease_token is null or old.lease_until is null or old.lease_until <= clock_timestamp() or
       new.attempt_count is distinct from old.attempt_count or
       new.cycle_attempt_count is distinct from old.cycle_attempt_count or
       new.retry_cycle is distinct from old.retry_cycle or
       (new.state = 'ready' and new.adopted_attempt_id is distinct from old.active_attempt_id) then
      raise exception 'verified thumbnail derivative completion transition is invalid';
    end if;
  elsif old.state = 'failed' and new.state = 'pending' then
    if new.attempt_count is distinct from old.attempt_count or
       new.retry_cycle <> old.retry_cycle + 1 or new.cycle_attempt_count <> 0 then
      raise exception 'verified thumbnail derivative retry transition is invalid';
    end if;
  elsif old.state = new.state then
    if new.attempt_count is distinct from old.attempt_count or
       new.cycle_attempt_count is distinct from old.cycle_attempt_count or
       new.retry_cycle is distinct from old.retry_cycle or
       new.lease_token is distinct from old.lease_token or
       new.lease_until is distinct from old.lease_until then
      raise exception 'verified thumbnail derivative same-state transition is invalid';
    end if;
  else
    raise exception 'verified thumbnail derivative state transition is invalid';
  end if;
  return new;
end;
$$;

create trigger media_derivatives_protect_verified_thumbnail_transition
before update on app_private.media_derivatives
for each row execute function app_private.protect_verified_thumbnail_derivative_transition();

create function app_private.prevent_media_derivative_attempt_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'media derivative attempt ledger cannot be deleted';
end;
$$;

create trigger media_derivative_attempts_prevent_delete
before delete on app_private.media_derivative_attempts
for each row execute function app_private.prevent_media_derivative_attempt_delete();

create function app_private.assert_media_derivative_attempt_references()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from app_private.media_derivatives derivative
    where derivative.active_attempt_id = new.id and new.state not in ('reserved', 'uploaded')
  ) then
    raise exception 'active media derivative attempt must remain reserved or uploaded';
  end if;
  if exists (
    select 1 from app_private.media_derivatives derivative
    where derivative.adopted_attempt_id = new.id and new.state <> 'adopted'
  ) then
    raise exception 'adopted media derivative attempt is immutable';
  end if;
  return new;
end;
$$;

create constraint trigger media_derivative_attempts_valid_references
after update on app_private.media_derivative_attempts
deferrable initially deferred for each row execute function app_private.assert_media_derivative_attempt_references();

revoke execute on function app_private.protect_media_derivative_attempt() from public, anon, authenticated, service_role;
revoke execute on function app_private.protect_verified_thumbnail_derivative_transition() from public, anon, authenticated, service_role;
revoke execute on function app_private.prevent_media_derivative_attempt_delete() from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_media_derivative_attempt_references() from public, anon, authenticated, service_role;

reset role;
revoke app_migrator from postgres;

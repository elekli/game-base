do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_migrator') then
    create role app_migrator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$$;

grant app_migrator to postgres;

alter role app_runtime set statement_timeout = '15s';
alter role app_runtime set idle_in_transaction_session_timeout = '15s';

create schema if not exists app_private authorization app_migrator;

revoke all on schema app_private from public, anon, authenticated, service_role;
grant usage on schema app_private to app_runtime;

alter default privileges for role app_migrator in schema app_private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role app_migrator in schema app_private
  grant select, insert, update, delete on tables to app_runtime;
alter default privileges for role app_migrator in schema app_private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role app_migrator in schema app_private
  grant usage, select on sequences to app_runtime;
alter default privileges for role app_migrator in schema app_private
  revoke execute on functions from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('game-media', 'game-media', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

revoke all on all tables in schema app_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema app_private from public, anon, authenticated, service_role;
revoke execute on all functions in schema app_private from public, anon, authenticated, service_role;

revoke app_migrator from postgres;

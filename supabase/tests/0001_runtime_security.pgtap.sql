begin;

create extension if not exists pgtap with schema extensions;
select plan(14);

select ok(exists(select 1 from pg_roles where rolname = 'app_runtime'), 'runtime role exists');
select ok(exists(select 1 from pg_roles where rolname = 'app_migrator'), 'migration role exists');
select ok(not (select rolsuper from pg_roles where rolname = 'app_runtime'), 'runtime is not superuser');
select ok(not (select rolbypassrls from pg_roles where rolname = 'app_runtime'), 'runtime cannot bypass RLS');
select ok(not (select rolcreaterole from pg_roles where rolname = 'app_runtime'), 'runtime cannot create roles');
select ok(
  (select nspowner <> (select oid from pg_roles where rolname = 'app_runtime')
   from pg_namespace where nspname = 'app_private'),
  'runtime does not own product schema'
);
select ok(not has_schema_privilege('anon', 'app_private', 'usage'), 'anon cannot use product schema');
select ok(not has_schema_privilege('authenticated', 'app_private', 'usage'), 'authenticated cannot use product schema');
select ok(not has_schema_privilege('service_role', 'app_private', 'usage'), 'Data API service role cannot use product schema');

grant app_migrator to postgres;
set local role app_migrator;
create table app_private.default_privilege_probe (id bigint generated always as identity primary key);
alter table app_private.default_privilege_probe enable row level security;
reset role;

select ok(has_table_privilege('app_runtime', 'app_private.default_privilege_probe', 'select'), 'runtime receives intended default table grants');
select ok(not has_table_privilege('anon', 'app_private.default_privilege_probe', 'select'), 'anon receives no default table grants');
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.default_privilege_probe'::regclass),
  'product table has RLS enabled'
);

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
select extensions.ok(
  (select count(*) = 0 from app_private.default_privilege_probe),
  'runtime sees no rows without an RLS policy'
);
reset role;

select ok(
  exists(
    select 1 from storage.buckets
    where id = 'game-media' and public = false and file_size_limit = 52428800
  ),
  'media bucket is private and limited to 50 MiB'
);

select * from finish();
rollback;

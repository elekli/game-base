begin;

create extension if not exists pgtap with schema extensions;
select plan(21);

select ok(exists(select 1 from pg_roles where rolname = 'app_runtime'), 'runtime role exists');
select ok(exists(select 1 from pg_roles where rolname = 'app_migrator'), 'migration role exists');
select ok(not (select rolsuper from pg_roles where rolname = 'app_runtime'), 'runtime is not superuser');
select ok(not (select rolbypassrls from pg_roles where rolname = 'app_runtime'), 'runtime cannot bypass RLS');
select ok(not (select rolcreaterole from pg_roles where rolname = 'app_runtime'), 'runtime cannot create roles');
select ok(
  (select nspowner = (select oid from pg_roles where rolname = 'app_migrator')
   from pg_namespace where nspname = 'app_private'),
  'migration role owns product schema'
);
select ok(not has_schema_privilege('anon', 'app_private', 'usage'), 'anon cannot use product schema');
select ok(not has_schema_privilege('authenticated', 'app_private', 'usage'), 'authenticated cannot use product schema');
select ok(not has_schema_privilege('service_role', 'app_private', 'usage'), 'Data API service role cannot use product schema');

grant app_migrator to postgres;
set local role app_migrator;
create table app_private.default_privilege_probe (
  id bigint generated always as identity primary key,
  marker text not null default 'unchanged'
);
alter table app_private.default_privilege_probe enable row level security;
insert into app_private.default_privilege_probe overriding system value values (1);
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
  'runtime cannot read an existing row without an RLS policy'
);
select extensions.throws_like(
  $$insert into app_private.default_privilege_probe default values$$,
  '%row-level security policy%',
  'runtime cannot insert without an RLS policy'
);
select extensions.is_empty(
  $$update app_private.default_privilege_probe set marker = 'changed' where id = 1 returning id$$,
  'runtime cannot update a row hidden by RLS'
);
select extensions.is_empty(
  $$delete from app_private.default_privilege_probe where id = 1 returning id$$,
  'runtime cannot delete a row hidden by RLS'
);
reset role;

select ok(
  exists(
    select 1 from storage.buckets
    where id = 'game-media' and public = false and file_size_limit = 52428800
  ),
  'media bucket is private and limited to 50 MiB'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
  'storage objects has RLS enabled'
);
select ok(
  not has_table_privilege('app_runtime', 'storage.objects', 'select,insert,update,delete'),
  'runtime role has no direct storage object privileges'
);

insert into storage.objects (bucket_id, name)
values ('game-media', 'pgtap/authorization-probe');

grant usage on schema extensions to anon;
set local role anon;
select extensions.ok(
  (select count(*) = 0
   from storage.objects
   where bucket_id = 'game-media' and name = 'pgtap/authorization-probe'),
  'anon cannot read a private storage object'
);
select extensions.throws_like(
  $$insert into storage.objects (bucket_id, name) values ('game-media', 'pgtap/unauthorized-write')$$,
  '%row-level security policy%',
  'anon cannot write a private storage object'
);
reset role;

select * from finish();
rollback;

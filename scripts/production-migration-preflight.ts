import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { deploymentBindings } from "../src/shared/config/deployment-bindings";

type MigrationIdentity = Readonly<{ version: string; name: string }>;
type RlsPolicyIdentity = Readonly<{
  table: string;
  name: string;
  permissiveness: "PERMISSIVE" | "RESTRICTIVE";
  command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  roles: string[];
  using: string | null;
  withCheck: string | null;
}>;
type ExpectedRlsPolicyRevision = RlsPolicyIdentity &
  Readonly<{
    validFrom: string;
    validUntilExclusive: string | null;
  }>;
type ReachableRole = Readonly<{
  name: string;
  isSuperuser: boolean;
  bypassRls: boolean;
  canCreateRole: boolean;
  canCreateDatabase: boolean;
}>;
type AppPrivateObject = Readonly<{
  kind: string;
  identity: string;
  owner: string;
  extensionOwned: boolean;
}>;

export type ProductionDatabaseSnapshot = {
  migrations: MigrationIdentity[];
  appMigratorExists: boolean;
  appMigratorIsRestricted: boolean;
  appRuntimeExists: boolean;
  appRuntimeIsRestricted: boolean;
  appRuntimeReachableRoles: ReachableRole[];
  appPrivateOwnedByMigrator: boolean;
  appPrivateObjects: AppPrivateObject[];
  dangerousInboundRoleCount: number;
  unexpectedAclCount: number;
  defaultPrivilegeDriftCount: number;
  unsafeGrantCount: number;
  knownPublicExecuteDriftCount: number;
  appRuntimeCanExecuteKnownDriftFunction: boolean;
  appRuntimeDirectExecuteGrantCount: number;
  missingRuntimeGrantCount: number;
  rlsDisabledCount: number;
  rlsPolicies: RlsPolicyIdentity[];
  bucketExists: boolean;
  bucketIsPrivate: boolean;
  bucketFileSizeLimit: number | null;
  storageObjectsRlsEnabled: boolean;
};

export type ReadOnlyDatabaseSession = {
  unsafe<T>(query: string): Promise<T[]>;
  release(): Promise<void> | void;
};

type ProductionBinding = Readonly<{
  databaseName: string;
  projectRef: string;
  supavisorHost: string;
}>;

const MIGRATION_FILE = /^(\d+)_([a-z0-9_]+)\.sql$/;
const LINT_BASELINE_PATH = ".github/production-migration-lint-baseline.json";
const RLS_POLICY_MANIFEST_PATH = ".github/production-rls-policy-manifest.json";
const RUNTIME_ROLE_REACHABILITY_ALLOWLIST_PATH =
  ".github/production-runtime-role-reachability-allowlist.json";
const KNOWN_DRIFT_REMEDIATION_NAME = "revoke_public_platform_trigger_execute";
const KNOWN_DRIFT_REMEDIATION_SQL =
  "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n";
const INITIAL_LINT_BASELINE = {
  "0001_runtime_security.sql":
    "c6bf64ba267281f66cbedfffd6854c3a2eade1e9631587a2e738fee9a544d787",
  "0002_games_and_source_identity.sql":
    "75cad41a3f40eed94856405c3905bf17963fc7744cc4877c9a98d3532ed44bdf",
  "0003_source_snapshot_and_source_cover.sql":
    "1f29d1009c15d8a033342b35e697ff32430a8fee35464264002779a02e194080",
  "0004_library_curation.sql":
    "4beeb1353655f13be7624fe318db730c8fccc63271195704095fc90ba6076769",
  "0005_source_refresh.sql":
    "6a00b22139392512a2b81fc0ebb606fe3f15660360c937936ff2f7911c58942a",
  "0006_library_invariants.sql":
    "a1d9e8b3ae4e03aacb2b3a78046c3dd5dffdf8a1aa732c62484097b379e88e62",
} as const;
const FORBIDDEN_DDL = [
  /\bdrop\b/i,
  /\balter\s+table\b[^;]*?\bdrop\s+(?:column|constraint)\b/i,
  /\balter\s+table\b[^;]*?\badd\s+constraint\b/i,
  /\balter\s+table\b[^;]*?\badd\s+(?:column\s+)?[^;]*?\bnot\s+null\b/i,
  /\balter\s+table\b[^;]*?\balter\s+(?:column\s+)?\S+\s+(?:(?:set\s+data\s+)?type|set\s+not\s+null)\b/i,
  /\balter\s+table\b[^;]*?\bdisable\s+row\s+level\s+security\b/i,
  /\btruncate\b/i,
  /\bcreate\s+unique\s+index\b/i,
] as const;

const SNAPSHOT_QUERY = `
select json_build_object(
  'migrations', coalesce((
    select json_agg(json_build_object('version', version, 'name', name) order by version)
    from supabase_migrations.schema_migrations
  ), '[]'::json),
  'appMigratorExists', exists(select 1 from pg_roles where rolname = 'app_migrator'),
  'appMigratorIsRestricted', coalesce((
    select not rolsuper and not rolinherit and not rolreplication
      and not rolbypassrls and not rolcreatedb and not rolcreaterole
    from pg_roles where rolname = 'app_migrator'
  ), false),
  'appRuntimeExists', exists(select 1 from pg_roles where rolname = 'app_runtime'),
  'appRuntimeIsRestricted', coalesce((
    select not rolsuper and not rolinherit and not rolreplication
      and not rolbypassrls and not rolcreatedb and not rolcreaterole
    from pg_roles where rolname = 'app_runtime'
  ), false),
  'appRuntimeReachableRoles', coalesce((
    with recursive reachable_role(role_oid) as (
      select membership.roleid
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
      where member_role.rolname = 'app_runtime'
        and (
          membership.inherit_option
          or membership.set_option
          or membership.admin_option
        )
      union
      select membership.roleid
      from pg_auth_members membership
      join reachable_role reachable on reachable.role_oid = membership.member
      where membership.inherit_option
        or membership.set_option
        or membership.admin_option
    )
    select json_agg(json_build_object(
      'name', role.rolname,
      'isSuperuser', role.rolsuper,
      'bypassRls', role.rolbypassrls,
      'canCreateRole', role.rolcreaterole,
      'canCreateDatabase', role.rolcreatedb
    ) order by role.rolname)
    from reachable_role reachable
    join pg_roles role on role.oid = reachable.role_oid
  ), '[]'::json),
  'appPrivateOwnedByMigrator', coalesce((
    select nspowner = (select oid from pg_roles where rolname = 'app_migrator')
    from pg_namespace where nspname = 'app_private'
  ), false),
  'appPrivateObjects', coalesce((
    select json_agg(json_build_object(
      'kind', object.kind,
      'identity', object.identity,
      'owner', object.owner,
      'extensionOwned', object.extension_owned
    ) order by object.kind, object.identity)
    from (
      select
        case c.relkind
          when 'r' then 'table'
          when 'p' then 'partitioned-table'
          when 'S' then 'sequence'
          when 'v' then 'view'
          when 'm' then 'materialized-view'
          when 'f' then 'foreign-table'
          when 'c' then 'composite-type'
          else 'unknown-relation'
        end as kind,
        c.relname as identity,
        owner.rolname as owner,
        exists (
          select 1 from pg_depend dependency
          where dependency.classid = 'pg_class'::regclass
            and dependency.objid = c.oid
            and dependency.deptype = 'e'
        ) as extension_owned
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles owner on owner.oid = c.relowner
      where n.nspname = 'app_private' and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c')
      union all
      select
        case procedure.prokind
          when 'p' then 'procedure'
          when 'a' then 'aggregate'
          when 'w' then 'window-function'
          else 'function'
        end as kind,
        procedure.oid::regprocedure::text as identity,
        owner.rolname as owner,
        exists (
          select 1 from pg_depend dependency
          where dependency.classid = 'pg_proc'::regclass
            and dependency.objid = procedure.oid
            and dependency.deptype = 'e'
        ) as extension_owned
      from pg_proc procedure
      join pg_namespace n on n.oid = procedure.pronamespace
      join pg_roles owner on owner.oid = procedure.proowner
      where n.nspname = 'app_private'
      union all
      select
        'type' as kind,
        object_type.typname as identity,
        owner.rolname as owner,
        exists (
          select 1 from pg_depend dependency
          where dependency.classid = 'pg_type'::regclass
            and dependency.objid = object_type.oid
            and dependency.deptype = 'e'
        ) as extension_owned
      from pg_type object_type
      join pg_namespace n on n.oid = object_type.typnamespace
      join pg_roles owner on owner.oid = object_type.typowner
      where n.nspname = 'app_private'
        and object_type.typrelid = 0
        and object_type.typelem = 0
    ) object
  ), '[]'::json),
  'dangerousInboundRoleCount', (
    with recursive inbound_role(role_oid) as (
      select membership.member
      from pg_auth_members membership
      join pg_roles target on target.oid = membership.roleid
      where target.rolname in ('app_runtime', 'app_migrator')
        and (membership.inherit_option or membership.set_option or membership.admin_option)
      union
      select membership.member
      from pg_auth_members membership
      join inbound_role inbound on inbound.role_oid = membership.roleid
      where membership.inherit_option or membership.set_option or membership.admin_option
    )
    select count(*) from inbound_role inbound
    join pg_roles role on role.oid = inbound.role_oid
    where role.rolcanlogin or role.rolsuper or role.rolbypassrls
      or role.rolcreaterole or role.rolcreatedb or role.rolreplication
      or role.rolname in ('anon', 'authenticated', 'service_role')
  ),
  'unexpectedAclCount', (
    select count(*) from (
      select grantee.rolname, privilege.privilege_type
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where n.nspname = 'app_private'
        and not (
          grantee.rolname = 'app_migrator'
          or (
            grantee.rolname = 'app_runtime'
            and privilege.privilege_type = 'USAGE'
            and not privilege.is_grantable
          )
        )
      union all
      select grantee.rolname, privilege.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault(
        case when c.relkind = 'S' then 'S'::"char" else 'r'::"char" end,
        c.relowner
      ))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where n.nspname = 'app_private' and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
        and not (
          grantee.rolname = 'app_migrator'
          or (
            grantee.rolname = 'app_runtime'
            and not privilege.is_grantable
            and (
              (c.relkind = 'S' and privilege.privilege_type in ('USAGE', 'SELECT'))
              or (c.relkind <> 'S' and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
            )
          )
        )
      union all
      select grantee.rolname, privilege.privilege_type
      from pg_proc procedure
      join pg_namespace n on n.oid = procedure.pronamespace
      cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where n.nspname = 'app_private'
        and not (
          grantee.rolname = 'app_migrator'
          or (
            privilege.grantee = 0
            and procedure.proname = 'prevent_system_platform_mutation'
            and procedure.pronargs = 0
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
          )
        )
      union all
      select grantee.rolname, privilege.privilege_type
      from pg_type object_type
      join pg_namespace n on n.oid = object_type.typnamespace
      left join pg_class type_relation on type_relation.oid = object_type.typrelid
      cross join lateral aclexplode(coalesce(object_type.typacl, acldefault('T', object_type.typowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where n.nspname = 'app_private'
        and (object_type.typrelid = 0 or type_relation.relkind = 'c')
        and object_type.typelem = 0
        and grantee.rolname <> 'app_migrator'
      union all
      select grantee.rolname, privilege.privilege_type
      from pg_attribute attribute
      join pg_class c on c.oid = attribute.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(attribute.attacl) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where n.nspname = 'app_private' and attribute.attacl is not null
    ) unexpected_acl
  ),
  'defaultPrivilegeDriftCount', (
    select count(*) from (
      select default_acl.defaclobjtype, grantee.rolname, privilege.privilege_type
      from pg_default_acl default_acl
      join pg_roles owner on owner.oid = default_acl.defaclrole
      join pg_namespace n on n.oid = default_acl.defaclnamespace
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
      where owner.rolname = 'app_migrator' and n.nspname = 'app_private'
        and not (
          grantee.rolname = 'app_runtime'
          and not privilege.is_grantable
          and (
            (default_acl.defaclobjtype = 'r' and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
            or (default_acl.defaclobjtype = 'S' and privilege.privilege_type in ('USAGE', 'SELECT'))
          )
        )
    ) unexpected_default_acl
  ) + (
    select count(*) from (values
      ('r'::"char", 'SELECT'), ('r'::"char", 'INSERT'),
      ('r'::"char", 'UPDATE'), ('r'::"char", 'DELETE'),
      ('S'::"char", 'USAGE'), ('S'::"char", 'SELECT')
    ) expected_default_acl(object_type, privilege_type)
    where not exists (
      select 1
      from pg_default_acl default_acl
      join pg_roles owner on owner.oid = default_acl.defaclrole
      join pg_namespace n on n.oid = default_acl.defaclnamespace
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      join pg_roles grantee on grantee.oid = privilege.grantee
      where owner.rolname = 'app_migrator' and n.nspname = 'app_private'
        and default_acl.defaclobjtype = expected_default_acl.object_type
        and grantee.rolname = 'app_runtime'
        and privilege.privilege_type = expected_default_acl.privilege_type
    )
  ),
  'unsafeGrantCount', (
    select count(*) from (
      select privilege.grantee
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 'S'::\"char\" else 'r'::\"char\" end, c.relowner))) privilege
      left join pg_roles granted_role on granted_role.oid = privilege.grantee
      where n.nspname = 'app_private'
        and c.relkind in ('r', 'p', 'S')
        and (privilege.grantee = 0 or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
      union all
      select privilege.grantee
      from pg_proc procedure
      join pg_namespace n on n.oid = procedure.pronamespace
      cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
      left join pg_roles granted_role on granted_role.oid = privilege.grantee
      where n.nspname = 'app_private'
        and (privilege.grantee = 0 or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
      union all
      select privilege.grantee
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) privilege
      left join pg_roles granted_role on granted_role.oid = privilege.grantee
      where n.nspname = 'app_private'
        and (privilege.grantee = 0 or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
    ) unsafe_grant
  ),
  'knownPublicExecuteDriftCount', (
    select count(*)
    from pg_proc procedure
    join pg_namespace n on n.oid = procedure.pronamespace
    cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
    where n.nspname = 'app_private'
      and procedure.proname = 'prevent_system_platform_mutation'
      and procedure.pronargs = 0
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'appRuntimeCanExecuteKnownDriftFunction', coalesce(
    has_function_privilege(
      'app_runtime',
      to_regprocedure('app_private.prevent_system_platform_mutation()'),
      'EXECUTE'
    ),
    false
  ),
  'appRuntimeDirectExecuteGrantCount', (
    select count(*)
    from pg_proc procedure
    join pg_namespace n on n.oid = procedure.pronamespace
    cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
    where n.nspname = 'app_private'
      and procedure.proname = 'prevent_system_platform_mutation'
      and procedure.pronargs = 0
      and privilege.grantee = (select oid from pg_roles where rolname = 'app_runtime')
      and privilege.privilege_type = 'EXECUTE'
  ),
  'missingRuntimeGrantCount', (
    select
      case when has_schema_privilege('app_runtime', 'app_private', 'USAGE') then 0 else 1 end
      + count(*) filter (
          where c.relkind in ('r', 'p')
            and (
              not has_table_privilege('app_runtime', c.oid, 'SELECT')
              or not has_table_privilege('app_runtime', c.oid, 'INSERT')
              or not has_table_privilege('app_runtime', c.oid, 'UPDATE')
              or not has_table_privilege('app_runtime', c.oid, 'DELETE')
            )
        )
      + count(*) filter (
          where c.relkind = 'S'
            and (
              not has_sequence_privilege('app_runtime', c.oid, 'USAGE')
              or not has_sequence_privilege('app_runtime', c.oid, 'SELECT')
            )
        )
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relkind in ('r', 'p', 'S')
  ),
  'rlsDisabledCount', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relkind in ('r', 'p') and not c.relrowsecurity
  ),
  'rlsPolicies', coalesce((
    select json_agg(json_build_object(
      'table', policy.table_name,
      'name', policy.policy_name,
      'permissiveness', policy.permissiveness,
      'command', policy.command,
      'roles', policy.roles,
      'using', policy.using_expression,
      'withCheck', policy.with_check_expression
    ) order by policy.table_name, policy.policy_name)
    from (
      select
        c.relname as table_name,
        p.polname as policy_name,
        case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as permissiveness,
        case p.polcmd
          when '*' then 'ALL'
          when 'r' then 'SELECT'
          when 'a' then 'INSERT'
          when 'w' then 'UPDATE'
          when 'd' then 'DELETE'
          else 'UNKNOWN'
        end as command,
        (
          select coalesce(json_agg(
            case
              when policy_role.role_oid = 0 then 'PUBLIC'
              else coalesce(role.rolname, 'UNKNOWN_ROLE')
            end
            order by case
              when policy_role.role_oid = 0 then 'PUBLIC'
              else coalesce(role.rolname, 'UNKNOWN_ROLE')
            end
          ), '[]'::json)
          from unnest(p.polroles) as policy_role(role_oid)
          left join pg_roles role on role.oid = policy_role.role_oid
        ) as roles,
        pg_get_expr(p.polqual, p.polrelid) as using_expression,
        pg_get_expr(p.polwithcheck, p.polrelid) as with_check_expression
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app_private'
    ) policy
  ), '[]'::json),
  'bucketExists', exists(select 1 from storage.buckets where id = 'game-media'),
  'bucketIsPrivate', coalesce((select not public from storage.buckets where id = 'game-media'), false),
  'bucketFileSizeLimit', (select file_size_limit from storage.buckets where id = 'game-media'),
  'storageObjectsRlsEnabled', coalesce((
    select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
  ), false)
) as snapshot;
`;

class ProductionMigrationError extends Error {
  constructor(name: string, message: string) {
    super(`${name}: ${message}`);
    this.name = name;
  }
}

type SqlToken = Readonly<{
  kind: "word" | "identifier" | "string" | "dollar" | "symbol";
  value: string;
}>;

function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  const fail = () => {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "migration contains unterminated SQL syntax",
    );
  };
  while (index < sql.length) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) fail();
      continue;
    }
    const escapedString =
      (char === "e" || char === "E") && sql[index + 1] === "'";
    if (char === "'" || escapedString) {
      const start = index;
      index += escapedString ? 2 : 1;
      let closed = false;
      while (index < sql.length) {
        if (escapedString && sql[index] === "\\") {
          index += 2;
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) fail();
      tokens.push({ kind: "string", value: sql.slice(start, index) });
      continue;
    }
    if (char === '"') {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) fail();
      tokens.push({ kind: "identifier", value: sql.slice(start, index) });
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const contentStart = index + delimiter.length;
        const end = sql.indexOf(delimiter, contentStart);
        if (end < 0) fail();
        tokens.push({ kind: "dollar", value: sql.slice(contentStart, end) });
        index = end + delimiter.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
      tokens.push({ kind: "word", value: sql.slice(start, index).toLowerCase() });
      continue;
    }
    tokens.push({ kind: "symbol", value: char });
    index += 1;
  }
  return tokens;
}

function containsForbiddenMigrationSql(sql: string) {
  const tokens = lexSql(sql);
  for (const token of tokens) {
    if (token.kind === "word" && token.value === "do") return true;
  }
  let statementStart = 0;
  for (let index = 0; index <= tokens.length; index += 1) {
    if (index < tokens.length && tokens[index]?.value !== ";") continue;
    const statement = tokens.slice(statementStart, index);
    statementStart = index + 1;
    const words = statement
      .filter((token) => token.kind === "word")
      .map((token) => token.value);
    const alterIndex = words.indexOf("alter");
    const renameIndex = words.indexOf("rename", alterIndex + 1);
    if (
      alterIndex >= 0 &&
      renameIndex > alterIndex &&
      words.indexOf("to", renameIndex + 1) > renameIndex
    ) {
      return true;
    }
    const ownerIndex = words.indexOf("owner", alterIndex + 1);
    if (
      alterIndex >= 0 &&
      ownerIndex > alterIndex &&
      words.indexOf("to", ownerIndex + 1) > ownerIndex
    ) {
      return true;
    }
    if (
      (words[0] === "create" || words[0] === "alter") &&
      (words[1] === "role" || words[1] === "user" || words[1] === "group")
    ) {
      return true;
    }
    if (words.includes("grant") || words.includes("revoke")) return true;
    if (words[0] === "alter" && words[1] === "domain") return true;
    const isRoutineDefinition =
      words[0] === "create" &&
      (words.includes("function") || words.includes("procedure"));
    if (!isRoutineDefinition) continue;
    const asIndex = statement.findIndex(
      (token) => token.kind === "word" && token.value === "as",
    );
    const relativeBodyIndex = statement
      .slice(asIndex + 1)
      .findIndex((token) => token.kind === "string" || token.kind === "dollar");
    const bodyIndex =
      relativeBodyIndex < 0 ? -1 : asIndex + 1 + relativeBodyIndex;
    const body = statement[bodyIndex];
    if (!body) continue;
    const adjacentBody = statement[bodyIndex + 1];
    if (
      body.kind !== "dollar" ||
      adjacentBody?.kind === "string" ||
      adjacentBody?.kind === "dollar"
    ) {
      return true;
    }
    const bodySql = body.value;
    const bodyTokens = lexSql(bodySql);
    if (
      bodyTokens.some(
        (token) => token.kind === "word" && token.value === "execute",
      ) ||
      containsForbiddenMigrationSql(bodySql)
    ) {
      return true;
    }
  }
  const executableSql = tokens
    .filter(
      (token) =>
        token.kind === "word" ||
        token.kind === "identifier" ||
        token.kind === "symbol",
    )
    .map((token) => (token.kind === "identifier" ? "identifier" : token.value))
    .join(" ");
  return FORBIDDEN_DDL.some((pattern) => pattern.test(executableSql));
}

async function repositoryMigrations(root: string) {
  const directory = path.join(root, "supabase", "migrations");
  const filenames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    filenames.map(async (filename) => {
      const match = MIGRATION_FILE.exec(filename);
      if (!match) {
        throw new ProductionMigrationError(
          "ProductionMigrationSafetyError",
          "migration filename is not a stable versioned identifier",
        );
      }
      return {
        filename,
        version: match[1]!,
        name: match[2]!,
        sql: await readFile(path.join(directory, filename), "utf8"),
      };
    }),
  );
}

function parseLintBaseline(text: string) {
  const value = JSON.parse(text) as Record<string, string>;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "migration lint baseline is invalid",
    );
  }
  return value;
}

function stableBaseline(value: Record<string, string>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort()));
}

function stablePolicies(policies: readonly RlsPolicyIdentity[]) {
  return JSON.stringify(
    policies
      .map((policy) => ({ ...policy, roles: [...policy.roles].sort() }))
      .sort(
        (left, right) =>
          left.table.localeCompare(right.table) || left.name.localeCompare(right.name),
      ),
  );
}

async function repositoryRlsPolicies(
  root: string,
  migrations: readonly MigrationIdentity[],
) {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(path.join(root, RLS_POLICY_MANIFEST_PATH), "utf8"),
    );
  } catch {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "RLS policy manifest is missing or invalid",
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== "app_private" ||
    !Array.isArray((value as { policies?: unknown }).policies)
  ) {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "RLS policy manifest must describe app_private policies",
    );
  }
  const policies = (value as { policies: unknown[] }).policies;
  const commands = new Set(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]);
  const permissiveness = new Set(["PERMISSIVE", "RESTRICTIVE"]);
  const migrationIndexes = new Map(
    migrations.map((migration, index) => [migration.version, index]),
  );
  if (
    policies.some((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return true;
      }
      const policy = candidate as Record<string, unknown>;
      return (
        typeof policy.table !== "string" ||
        typeof policy.name !== "string" ||
        typeof policy.validFrom !== "string" ||
        !migrationIndexes.has(policy.validFrom) ||
        (policy.validUntilExclusive !== null &&
          (typeof policy.validUntilExclusive !== "string" ||
            !migrationIndexes.has(policy.validUntilExclusive))) ||
        typeof policy.permissiveness !== "string" ||
        !permissiveness.has(policy.permissiveness) ||
        typeof policy.command !== "string" ||
        !commands.has(policy.command) ||
        !Array.isArray(policy.roles) ||
        policy.roles.some((role) => typeof role !== "string") ||
        (policy.using !== null && typeof policy.using !== "string") ||
        (policy.withCheck !== null && typeof policy.withCheck !== "string")
      );
    })
  ) {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "RLS policy manifest contains an invalid policy",
    );
  }
  const typedPolicies = policies as ExpectedRlsPolicyRevision[];
  const revisionGroups = new Map<string, ExpectedRlsPolicyRevision[]>();
  for (const policy of typedPolicies) {
    const identity = `${policy.table}\0${policy.name}`;
    const group = revisionGroups.get(identity) ?? [];
    group.push(policy);
    revisionGroups.set(identity, group);
  }
  for (const revisions of revisionGroups.values()) {
    revisions.sort(
      (left, right) =>
        migrationIndexes.get(left.validFrom)! - migrationIndexes.get(right.validFrom)!,
    );
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index]!;
      const next = revisions[index + 1];
      const start = migrationIndexes.get(revision.validFrom)!;
      const end =
        revision.validUntilExclusive === null
          ? null
          : migrationIndexes.get(revision.validUntilExclusive)!;
      if (
        (end !== null && start >= end) ||
        (next && revision.validUntilExclusive !== next.validFrom) ||
        (!next && revision.validUntilExclusive !== null)
      ) {
        throw new ProductionMigrationError(
          "ProductionMigrationSafetyError",
          "RLS policy manifest revisions overlap or contain a gap",
        );
      }
    }
  }
  return typedPolicies;
}

export async function validateProductionRlsPolicyManifest(root: string) {
  const migrations = await repositoryMigrations(root);
  const policies = await repositoryRlsPolicies(root, migrations);
  return { policyRevisionCount: policies.length };
}

async function repositoryRuntimeReachableRoleAllowlist(root: string) {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        path.join(root, RUNTIME_ROLE_REACHABILITY_ALLOWLIST_PATH),
        "utf8",
      ),
    );
  } catch {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "runtime reachable-role allowlist is missing or invalid",
    );
  }
  const roles =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { appRuntimeReachableRoles?: unknown }).appRuntimeReachableRoles
      : undefined;
  if (
    !Array.isArray(roles) ||
    roles.some((role) => typeof role !== "string" || role.length === 0) ||
    new Set(roles).size !== roles.length ||
    roles.includes("app_runtime") ||
    roles.includes("app_migrator")
  ) {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "runtime reachable-role allowlist contains an invalid role",
    );
  }
  return roles as string[];
}

export async function validateProductionRuntimeRoleReachabilityAllowlist(root: string) {
  const roles = await repositoryRuntimeReachableRoleAllowlist(root);
  return { allowedRoleCount: roles.length };
}

export async function lintProductionMigrations(
  root: string,
  options: {
    trustedBaselineText?: string | null;
    trustedMigrationTexts?: Readonly<Record<string, string>>;
  } = {},
) {
  const migrations = await repositoryMigrations(root);
  if (options.trustedMigrationTexts) {
    for (const [filename, trustedSql] of Object.entries(
      options.trustedMigrationTexts,
    )) {
      const candidate = migrations.find((migration) => migration.filename === filename);
      if (!candidate || candidate.sql !== trustedSql) {
        throw new ProductionMigrationError(
          "ProductionMigrationSafetyError",
          "migration tracked by trusted main was modified or deleted",
        );
      }
    }
  }
  let baseline: Record<string, string> = {};
  let baselineText: string | null = null;
  try {
    baselineText = await readFile(path.join(root, LINT_BASELINE_PATH), "utf8");
    baseline = parseLintBaseline(baselineText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (options.trustedBaselineText !== undefined) {
    const trusted = options.trustedBaselineText;
    const isBootstrap =
      trusted === null &&
      stableBaseline(baseline) === stableBaseline(INITIAL_LINT_BASELINE);
    const isUnchanged =
      trusted !== null &&
      baselineText !== null &&
      stableBaseline(baseline) === stableBaseline(parseLintBaseline(trusted));
    if (!isBootstrap && !isUnchanged) {
      throw new ProductionMigrationError(
        "ProductionMigrationSafetyError",
        "migration lint baseline changed relative to trusted main",
      );
    }
  }
  for (const migration of migrations) {
    const digest = createHash("sha256").update(migration.sql).digest("hex");
    const isExactKnownRemediation =
      migration.name === KNOWN_DRIFT_REMEDIATION_NAME &&
      migration.sql === KNOWN_DRIFT_REMEDIATION_SQL;
    if (
      !isExactKnownRemediation &&
      containsForbiddenMigrationSql(migration.sql) &&
      baseline[migration.filename] !== digest
    ) {
      throw new ProductionMigrationError(
        "ProductionMigrationSafetyError",
        `unsplit destructive DDL in ${migration.filename}`,
      );
    }
  }
  for (const [filename, digest] of Object.entries(baseline)) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !migrations.some(
        (migration) =>
          migration.filename === filename &&
          createHash("sha256").update(migration.sql).digest("hex") === digest,
      )
    ) {
      throw new ProductionMigrationError(
        "ProductionMigrationSafetyError",
        "migration lint baseline contains a stale or invalid entry",
      );
    }
  }
  return { migrationCount: migrations.length };
}

export function validateProductionMigrationConnection(
  databaseUrl: string,
  binding: ProductionBinding = deploymentBindings.production,
) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new ProductionMigrationError(
      "ProductionMigrationConnectionError",
      "migration database URL is invalid",
    );
  }

  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  const username = decodeURIComponent(parsed.username);
  const databaseName = parsed.pathname.replace(/^\//, "");
  const sslMode = parsed.searchParams.get("sslmode");
  const directHost = `db.${binding.projectRef}.supabase.co`;
  const isDirect = parsed.hostname === directHost && ["postgres", "app_migrator"].includes(username);
  const isSession =
    parsed.hostname === binding.supavisorHost &&
    ["postgres", "app_migrator"].some(
      (role) => username === `${role}.${binding.projectRef}`,
    );

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    port !== 5432 ||
    sslMode !== "verify-full" ||
    databaseName !== binding.databaseName ||
    (!isDirect && !isSession)
  ) {
    throw new ProductionMigrationError(
      "ProductionMigrationConnectionError",
      "connection is not the bound Production direct or session migration endpoint",
    );
  }

  return {
    connectionMode: isDirect ? ("direct" as const) : ("session" as const),
    projectRef: binding.projectRef,
  };
}

function assertSnapshot(
  snapshot: ProductionDatabaseSnapshot,
  expectedMigrations: readonly MigrationIdentity[],
  expectedRlsPolicies: readonly ExpectedRlsPolicyRevision[],
  allowedRuntimeReachableRoles: readonly string[],
  knownDriftRemediationPending: boolean,
  phase: "pre-apply" | "strict",
) {
  const migrationHistoryMatches =
    snapshot.migrations.length <= expectedMigrations.length &&
    (phase === "pre-apply" ||
      snapshot.migrations.length === expectedMigrations.length) &&
    snapshot.migrations.every(
      (migration, index) =>
        JSON.stringify(migration) === JSON.stringify(expectedMigrations[index]),
    );
  const reachableRolesPass =
    Array.isArray(snapshot.appRuntimeReachableRoles) &&
    snapshot.appRuntimeReachableRoles.every(
      (role) =>
        role.name !== "app_migrator" &&
        !role.isSuperuser &&
        !role.bypassRls &&
        !role.canCreateRole &&
        !role.canCreateDatabase,
    ) &&
    JSON.stringify(
      snapshot.appRuntimeReachableRoles.map((role) => role.name).sort(),
    ) === JSON.stringify([...allowedRuntimeReachableRoles].sort());
  const rolesPass =
    snapshot.appMigratorExists &&
    snapshot.appMigratorIsRestricted &&
    snapshot.appRuntimeExists &&
    snapshot.appRuntimeIsRestricted &&
    snapshot.appPrivateOwnedByMigrator &&
    snapshot.dangerousInboundRoleCount === 0 &&
    reachableRolesPass;
  const objectOwnershipPass =
    Array.isArray(snapshot.appPrivateObjects) &&
    snapshot.appPrivateObjects.every(
      (object) => object.owner === "app_migrator" && !object.extensionOwned,
    );
  const strictGrantsPass =
    snapshot.unsafeGrantCount === 0 &&
    snapshot.knownPublicExecuteDriftCount === 0 &&
    snapshot.missingRuntimeGrantCount === 0 &&
    snapshot.unexpectedAclCount === 0 &&
    snapshot.defaultPrivilegeDriftCount === 0 &&
    !snapshot.appRuntimeCanExecuteKnownDriftFunction &&
    snapshot.appRuntimeDirectExecuteGrantCount === 0;
  const knownDriftIsRepairable =
    phase === "pre-apply" &&
    knownDriftRemediationPending &&
    snapshot.unsafeGrantCount === 1 &&
    snapshot.knownPublicExecuteDriftCount === 1 &&
    snapshot.missingRuntimeGrantCount === 0 &&
    snapshot.unexpectedAclCount === 0 &&
    snapshot.defaultPrivilegeDriftCount === 0 &&
    snapshot.appRuntimeCanExecuteKnownDriftFunction &&
    snapshot.appRuntimeDirectExecuteGrantCount === 0;
  const grantsPass = strictGrantsPass || knownDriftIsRepairable;
  const migrationIndexes = new Map(
    expectedMigrations.map((migration, index) => [migration.version, index]),
  );
  const tailIndex =
    phase === "strict"
      ? expectedMigrations.length - 1
      : snapshot.migrations.length - 1;
  const applicableRlsPolicies = expectedRlsPolicies
    .filter((policy) => {
      const start = migrationIndexes.get(policy.validFrom);
      const end =
        policy.validUntilExclusive === null
          ? null
          : migrationIndexes.get(policy.validUntilExclusive);
      return (
        start !== undefined &&
        start <= tailIndex &&
        (end === null || (end !== undefined && tailIndex < end))
      );
    })
    .map((policy) => ({
      table: policy.table,
      name: policy.name,
      permissiveness: policy.permissiveness,
      command: policy.command,
      roles: policy.roles,
      using: policy.using,
      withCheck: policy.withCheck,
    }));
  const rlsPass =
    snapshot.rlsDisabledCount === 0 &&
    Array.isArray(snapshot.rlsPolicies) &&
    stablePolicies(snapshot.rlsPolicies) === stablePolicies(applicableRlsPolicies);
  const bucketPass =
    snapshot.bucketExists &&
    snapshot.bucketIsPrivate &&
    snapshot.bucketFileSizeLimit === 52_428_800 &&
    snapshot.storageObjectsRlsEnabled;

  const failedChecks = [
    !migrationHistoryMatches && "migration-history",
    !rolesPass && "roles",
    !objectOwnershipPass && "object-owners",
    !grantsPass &&
      `grants(unsafe=${snapshot.unsafeGrantCount},missing=${snapshot.missingRuntimeGrantCount})`,
    !rlsPass && "rls",
    !bucketPass && "private-bucket",
  ].filter(Boolean);
  if (failedChecks.length > 0) {
    throw new ProductionMigrationError(
      "ProductionMigrationPreflightError",
      `Production database failed checks: ${failedChecks.join(",")}`,
    );
  }
  return knownDriftIsRepairable
    ? ("known-drift-remediation-required" as const)
    : ("strict" as const);
}

async function connectProduction(
  databaseUrl: string,
  caCertificate: string,
): Promise<ReadOnlyDatabaseSession> {
  if (
    !caCertificate.startsWith("-----BEGIN CERTIFICATE-----") ||
    !caCertificate.trimEnd().endsWith("-----END CERTIFICATE-----")
  ) {
    throw new ProductionMigrationError(
      "ProductionMigrationConnectionError",
      "Production migration CA certificate is missing or invalid",
    );
  }
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 1,
    onnotice: () => {},
    ssl: { ca: caCertificate, rejectUnauthorized: true },
  });
  let reserved: Awaited<ReturnType<typeof client.reserve>>;
  try {
    reserved = await client.reserve();
  } catch {
    try {
      await client.end({ timeout: 1 });
    } catch {
      throw new ProductionMigrationError(
        "ProductionMigrationConnectionError",
        "failed connection could not be cleaned up",
      );
    }
    throw new ProductionMigrationError(
      "ProductionMigrationConnectionError",
      "could not open the bound Production migration connection",
    );
  }
  return {
    unsafe: <T>(query: string) => reserved.unsafe(query) as unknown as Promise<T[]>,
    async release() {
      reserved.release();
      await client.end({ timeout: 1 });
    },
  };
}

export async function runProductionMigrationPreflight(options: {
  root: string;
  databaseUrl: string;
  caCertificate?: string;
  phase?: "pre-apply" | "strict";
  trustedBaselineText?: string | null;
  trustedMigrationTexts?: Readonly<Record<string, string>>;
  connect?: (databaseUrl: string) => Promise<ReadOnlyDatabaseSession>;
}) {
  const connection = validateProductionMigrationConnection(options.databaseUrl);
  const migrations = await repositoryMigrations(options.root);
  const expectedRlsPolicies = await repositoryRlsPolicies(options.root, migrations);
  const allowedRuntimeReachableRoles =
    await repositoryRuntimeReachableRoleAllowlist(options.root);
  await lintProductionMigrations(options.root, {
    trustedBaselineText: options.trustedBaselineText,
    trustedMigrationTexts: options.trustedMigrationTexts,
  });
  const session = options.connect
    ? await options.connect(options.databaseUrl)
    : await connectProduction(options.databaseUrl, options.caCertificate ?? "");
  let transactionStarted = false;
  try {
    await session.unsafe("begin transaction read only");
    transactionStarted = true;
    await session.unsafe("set local statement_timeout = '15s'");
    const rows = await session.unsafe<{ snapshot: ProductionDatabaseSnapshot }>(SNAPSHOT_QUERY);
    const snapshot = rows[0]?.snapshot;
    if (!snapshot) {
      throw new ProductionMigrationError(
        "ProductionMigrationPreflightError",
        "Production database returned no preflight evidence",
      );
    }
    const pendingMigrations = migrations.slice(snapshot.migrations.length);
    const namedRemediations = pendingMigrations.filter(
      (migration) => migration.name === KNOWN_DRIFT_REMEDIATION_NAME,
    );
    const knownDriftRemediationPending =
      namedRemediations.length === 1 &&
      namedRemediations[0]!.sql === KNOWN_DRIFT_REMEDIATION_SQL;
    const preflightState = assertSnapshot(
      snapshot,
      migrations.map(({ version, name }) => ({ version, name })),
      expectedRlsPolicies,
      allowedRuntimeReachableRoles,
      knownDriftRemediationPending,
      options.phase ?? "pre-apply",
    );
    const appliedMigrationCount = snapshot.migrations.length;
    return {
      projectRef: connection.projectRef,
      connectionMode: connection.connectionMode,
      migrationCount: migrations.length,
      appliedMigrationCount,
      pendingMigrationCount: migrations.length - appliedMigrationCount,
      preflightState,
      roleChecks: "passed" as const,
      objectOwnerChecks: "passed" as const,
      grantChecks: "passed" as const,
      rlsChecks: "passed" as const,
      privateBucketCheck: "passed" as const,
    };
  } finally {
    let rollbackFailed = false;
    if (transactionStarted) {
      try {
        await session.unsafe("rollback");
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      await session.release();
    } catch {
      throw new ProductionMigrationError(
        "ProductionMigrationConnectionError",
        "Production migration connection cleanup failed",
      );
    }
    if (rollbackFailed) {
      throw new ProductionMigrationError(
        "ProductionMigrationRollbackError",
        "read-only preflight transaction could not be explicitly rolled back",
      );
    }
  }
}

function trustedGitStateFromArgs() {
  const baselineRefIndex = process.argv.indexOf("--baseline-ref");
  if (baselineRefIndex < 0) return {};
  const baselineRef = process.argv[baselineRefIndex + 1];
  if (!baselineRef || !/^[A-Za-z0-9_./-]+$/.test(baselineRef)) {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "trusted baseline ref is invalid",
    );
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new ProductionMigrationError(
      "ProductionMigrationSafetyError",
      "trusted baseline ref does not resolve",
    );
  }
  const tracked = execFileSync(
    "git",
    ["ls-tree", "--name-only", baselineRef, "--", LINT_BASELINE_PATH],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const trustedBaselineText = tracked
    ? execFileSync("git", ["show", `${baselineRef}:${LINT_BASELINE_PATH}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    : null;
  const trustedMigrationPaths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baselineRef, "--", "supabase/migrations"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const trustedMigrationTexts = Object.fromEntries(
    trustedMigrationPaths.map((migrationPath) => [
      path.basename(migrationPath),
      execFileSync("git", ["show", `${baselineRef}:${migrationPath}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ]),
  );
  return { trustedBaselineText, trustedMigrationTexts };
}

async function main() {
  const trustedGitState = trustedGitStateFromArgs();
  if (process.argv.includes("--lint")) {
    const result = await lintProductionMigrations(process.cwd(), trustedGitState);
    console.log(JSON.stringify({ event: "production_migration_safety_passed", ...result }));
    return;
  }
  const databaseUrl = process.env.PRODUCTION_MIGRATION_DATABASE_URL;
  const caCertificate = process.env.PRODUCTION_MIGRATION_CA_CERT;
  if (!databaseUrl || !caCertificate) {
    throw new ProductionMigrationError(
      "ProductionMigrationConnectionError",
      "Production migration database URL and CA certificate are required",
    );
  }
  const result = await runProductionMigrationPreflight({
    root: process.cwd(),
    databaseUrl,
    caCertificate,
    ...trustedGitState,
    phase: process.argv.includes("--strict") ? "strict" : "pre-apply",
  });
  console.log(JSON.stringify({ event: "production_migration_preflight_passed", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    console.error("ProductionMigrationPreflightError: preflight failed; no secret details were emitted");
    process.exitCode = 1;
  });
}

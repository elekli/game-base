import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRODUCTION_MIGRATION_SNAPSHOT_QUERY,
  type ProductionDatabaseSnapshot,
} from "../../scripts/production-migration-preflight";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;

if (!directDatabaseUrl) {
  throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");
}

const adminDatabaseUrl = new URL(directDatabaseUrl);
adminDatabaseUrl.username = "supabase_admin";

const database = postgres(adminDatabaseUrl.toString(), {
  max: 1,
  prepare: false,
  onnotice: () => undefined,
});
const postgresDatabase = postgres(directDatabaseUrl, {
  max: 1,
  prepare: false,
  onnotice: () => undefined,
});

type MembershipEvidence = Readonly<{
  adminOption: boolean;
  grantor: string;
  inheritOption: boolean;
  setOption: boolean;
}>;

async function appMigratorMembershipEvidence() {
  return postgresDatabase.unsafe<MembershipEvidence[]>(`
    select
      grantor.rolname as grantor,
      membership.admin_option as "adminOption",
      membership.inherit_option as "inheritOption",
      membership.set_option as "setOption"
    from pg_auth_members membership
    join pg_roles granted_role on granted_role.oid = membership.roleid
    join pg_roles member_role on member_role.oid = membership.member
    join pg_roles grantor on grantor.oid = membership.grantor
    where granted_role.rolname = 'app_migrator'
      and member_role.rolname = 'postgres'
    order by grantor.rolname, membership.inherit_option,
      membership.set_option, membership.admin_option
  `);
}

async function snapshot(): Promise<ProductionDatabaseSnapshot> {
  const rows = await database.unsafe<{ snapshot: ProductionDatabaseSnapshot }[]>(
    PRODUCTION_MIGRATION_SNAPSHOT_QUERY,
  );
  return rows[0]!.snapshot;
}

describe("production migration PostgreSQL catalog checks", () => {
  beforeAll(async () => {
    await database.unsafe("select 1");
    await postgresDatabase.unsafe("select 1");
  });

  afterAll(async () => {
    await database.end();
    await postgresDatabase.end();
  });

  it("accepts the healthy ACL and exact effective default-privilege matrices", async () => {
    const healthy = await snapshot();

    expect(healthy.unexpectedAclCount).toBe(0);
    expect(healthy.defaultPrivilegeDriftCount).toBe(0);
    expect(healthy.runtimeGrantDriftCount).toBe(0);
    expect(healthy.productionSmokeSecurityDriftCount).toBe(0);
  });

  it.each([
    [
      "removed FORCE RLS",
      "set local role app_migrator; alter table app_private.production_smoke_canaries no force row level security; reset role;",
    ],
    [
      "direct runtime table access",
      "set local role app_migrator; grant select on app_private.production_smoke_canaries to app_runtime; reset role;",
    ],
    [
      "SECURITY INVOKER",
      "set local role app_migrator; alter function app_private.inspect_production_smoke_canary() security invoker; reset role;",
    ],
    [
      "mutable search_path",
      "set local role app_migrator; alter function app_private.inspect_production_smoke_canary() set search_path = public; reset role;",
    ],
    [
      "replaced function body",
      `set local role app_migrator;
       create or replace function app_private.inspect_production_smoke_canary()
       returns table (row_count bigint, identity text, generation text, action_sequence bigint, payload_sha256 text, phase text)
       language sql stable security definer set search_path = pg_catalog, app_private
       as $$ select 0::bigint, null::text, null::text, null::bigint, null::text, null::text $$;
       reset role;`,
    ],
  ])("detects production smoke security drift from %s", async (_case, mutation) => {
    const healthy = await snapshot();
    expect(healthy.productionSmokeSecurityDriftCount).toBe(0);

    await database.unsafe("begin");
    try {
      await database.unsafe(mutation);
      const drifted = await snapshot();
      expect(drifted.productionSmokeSecurityDriftCount).toBeGreaterThan(0);
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("revokes PUBLIC execute only after postgres switches to the function owner", async () => {
    const remediation = await readFile(
      "supabase/migrations/0010_revoke_public_platform_trigger_execute_as_owner.sql",
      "utf8",
    );
    const functionIdentity =
      "app_private.prevent_system_platform_mutation()";
    const identity = await postgresDatabase.unsafe<
      { currentUser: string; sessionUser: string }[]
    >(`
      select current_user as "currentUser", session_user as "sessionUser"
    `);
    expect(identity[0]).toEqual({
      currentUser: "postgres",
      sessionUser: "postgres",
    });

    const membershipBaseline = await appMigratorMembershipEvidence();
    expect(membershipBaseline.length).toBeGreaterThan(0);

    await postgresDatabase.unsafe("begin");
    try {
      await postgresDatabase.unsafe("grant app_migrator to postgres");
      const membershipWithTemporaryGrant =
        await appMigratorMembershipEvidence();
      expect(membershipWithTemporaryGrant).toEqual([
        {
          adminOption: false,
          grantor: "postgres",
          inheritOption: true,
          setOption: true,
        },
        ...membershipBaseline,
      ]);

      await postgresDatabase.unsafe(`
        set local role app_migrator;
        grant usage on schema app_private to postgres;
        grant execute on function ${functionIdentity} to public;
        reset role;
        revoke app_migrator from postgres;
      `);
      expect(await appMigratorMembershipEvidence()).toEqual(membershipBaseline);

      await postgresDatabase.unsafe(
        `revoke execute on function ${functionIdentity} from public`,
      );

      const afterMemberRevoke = await postgresDatabase.unsafe<
        {
          acl: string[];
          currentUser: string;
          memberOfOwnerRole: boolean;
          publicCanExecute: boolean;
        }[]
      >(`
        select
          coalesce(procedure.proacl::text[], array[]::text[]) as acl,
          current_user as "currentUser",
          pg_has_role(current_user, 'app_migrator', 'member') as "memberOfOwnerRole",
          has_function_privilege('public', procedure.oid, 'execute') as "publicCanExecute"
        from pg_proc procedure
        where procedure.oid = to_regprocedure('${functionIdentity}')
      `);
      expect(afterMemberRevoke[0]).toMatchObject({
        currentUser: "postgres",
        memberOfOwnerRole: true,
        publicCanExecute: true,
      });
      expect(afterMemberRevoke[0]!.acl).toContain("=X/app_migrator");

      await postgresDatabase.unsafe(remediation);

      const afterOwnerRevoke = await postgresDatabase.unsafe<
        {
          acl: string[];
          currentUser: string;
          publicCanExecute: boolean;
          runtimeCanExecute: boolean;
        }[]
      >(`
        select
          coalesce(procedure.proacl::text[], array[]::text[]) as acl,
          current_user as "currentUser",
          has_function_privilege('public', procedure.oid, 'execute') as "publicCanExecute",
          has_function_privilege('app_runtime', procedure.oid, 'execute') as "runtimeCanExecute"
        from pg_proc procedure
        where procedure.oid = to_regprocedure('${functionIdentity}')
      `);
      expect(afterOwnerRevoke[0]).toMatchObject({
        currentUser: "postgres",
        publicCanExecute: false,
        runtimeCanExecute: false,
      });
      expect(afterOwnerRevoke[0]!.acl).not.toContain("=X/app_migrator");
      expect(await appMigratorMembershipEvidence()).toEqual(membershipBaseline);
    } finally {
      await postgresDatabase.unsafe("rollback");
    }
  });

  it("detects PUBLIC OID 0 grants across every supported catalog branch", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create foreign data wrapper acl_probe_fdw;
        create server acl_probe_server foreign data wrapper acl_probe_fdw;
        create foreign table app_private.acl_probe_foreign (id uuid) server acl_probe_server;
        grant select on app_private.acl_probe_foreign to public;
        set local role app_migrator;
        grant usage on schema app_private to public;
        grant select on app_private.games to public;
        grant select (id) on app_private.games to public;
        create view app_private.acl_probe_view as select id from app_private.games;
        grant select on app_private.acl_probe_view to public;
        create materialized view app_private.acl_probe_materialized_view as select id from app_private.games;
        grant select on app_private.acl_probe_materialized_view to public;
        create sequence app_private.acl_probe_sequence;
        grant usage on sequence app_private.acl_probe_sequence to public;
        create domain app_private.acl_probe_domain as text;
        grant usage on type app_private.acl_probe_domain to public;
        create function app_private.acl_probe_function() returns integer
          language sql as $$ select 1 $$;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.unexpectedAclCount).toBeGreaterThanOrEqual(
        healthy.unexpectedAclCount + 9,
      );
      expect(polluted.unsafeGrantCount).toBeGreaterThanOrEqual(
        healthy.unsafeGrantCount + 9,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("detects an extra PUBLIC default privilege with its grant option", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_probe_role;
        set local role app_migrator;
        alter default privileges in schema app_private
          grant select on tables to public;
        alter default privileges in schema app_private
          grant insert on tables to acl_probe_role with grant option;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.defaultPrivilegeDriftCount).toBeGreaterThan(
        healthy.defaultPrivilegeDriftCount,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("rejects runtime column REFERENCES and every column grant option", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        set local role app_migrator;
        grant references (id) on app_private.games to app_runtime;
        grant select (id) on app_private.games to app_runtime with grant option;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.unexpectedAclCount).toBeGreaterThanOrEqual(
        healthy.unexpectedAclCount + 2,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("rejects app_runtime execute on a function outside the fixed smoke API", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        set local role app_migrator;
        create function app_private.acl_probe_runtime_function() returns integer
          language sql as $$ select 1 $$;
        grant execute on function app_private.acl_probe_runtime_function() to app_runtime;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.unexpectedAclCount).toBeGreaterThanOrEqual(
        healthy.unexpectedAclCount + 1,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("rejects restoring runtime DELETE on reconciliation ledgers", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        set local role app_migrator;
        grant delete on app_private.media_cleanup_jobs, app_private.media_reconciliation_runs to app_runtime;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.unexpectedAclCount).toBeGreaterThanOrEqual(
        healthy.unexpectedAclCount + 2,
      );
      expect(polluted.runtimeGrantDriftCount).toBeGreaterThanOrEqual(
        healthy.runtimeGrantDriftCount + 2,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("rejects every role-wide app_migrator default ACL", async () => {
    const healthy = await snapshot();
    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_global_probe_role;
        set local role app_migrator;
        alter default privileges grant select on tables to public;
        alter default privileges
          grant insert on tables to acl_global_probe_role with grant option;
        reset role;
      `);

      const polluted = await snapshot();
      expect(polluted.defaultPrivilegeDriftCount).toBeGreaterThan(
        healthy.defaultPrivilegeDriftCount,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it.each([
    ["app_migrator", "appMigratorIsRestricted"],
    ["app_runtime", "appRuntimeIsRestricted"],
  ] as const)("rejects NOLOGIN drift for %s", async (role, snapshotField) => {
    const healthy = await snapshot();
    expect(healthy[snapshotField]).toBe(true);

    await database.unsafe("begin");
    try {
      await database.unsafe(`alter role ${role} nologin`);
      const drifted = await snapshot();
      expect(drifted[snapshotField]).toBe(false);
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("allows only PostgreSQL's two direct ADMIN-only role-creator memberships", async () => {
    const healthy = await snapshot();
    expect(healthy.expectedCreatorAdminMembershipCount).toBe(2);
    expect(healthy.unexpectedInboundMembershipCount).toBe(0);

    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_inbound_probe;
        grant app_runtime to acl_inbound_probe with inherit true, set false, admin false;
      `);
      const drifted = await snapshot();
      expect(drifted.unexpectedInboundMembershipCount).toBe(1);
    } finally {
      await database.unsafe("rollback");
    }
  });

  it("rejects an extra direct membership even when every option is false", async () => {
    const healthy = await snapshot();
    expect(healthy.unexpectedInboundMembershipCount).toBe(0);

    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_inert_inbound_probe;
        grant app_runtime to acl_inert_inbound_probe
          with inherit false, set false, admin false;
      `);
      const drifted = await snapshot();
      expect(drifted.unexpectedInboundMembershipCount).toBe(1);
      expect(drifted.appRuntimeReachableRoles).toEqual(
        healthy.appRuntimeReachableRoles,
      );
    } finally {
      await database.unsafe("rollback");
    }
  });

  it.each([
    ["INHERIT TRUE, SET FALSE, ADMIN FALSE"],
    ["INHERIT FALSE, SET TRUE, ADMIN FALSE"],
    ["INHERIT FALSE, SET FALSE, ADMIN TRUE"],
  ])("detects app_migrator outward reachability through %s", async (options) => {
    const healthy = await snapshot();
    expect(healthy.appMigratorReachableRoles).toEqual([]);

    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_elevated_probe superuser;
        grant acl_elevated_probe to app_migrator with ${options};
      `);
      const drifted = await snapshot();
      expect(drifted.appMigratorReachableRoles).toHaveLength(1);
    } finally {
      await database.unsafe("rollback");
    }
  });
});

import postgres from "postgres";
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

async function snapshot(): Promise<ProductionDatabaseSnapshot> {
  const rows = await database.unsafe<{ snapshot: ProductionDatabaseSnapshot }[]>(
    PRODUCTION_MIGRATION_SNAPSHOT_QUERY,
  );
  return rows[0]!.snapshot;
}

describe("production migration PostgreSQL catalog checks", () => {
  beforeAll(async () => {
    await database.unsafe("select 1");
  });

  afterAll(async () => {
    await database.end();
  });

  it("accepts the healthy ACL and exact effective default-privilege matrices", async () => {
    const healthy = await snapshot();

    expect(healthy.unexpectedAclCount).toBe(0);
    expect(healthy.defaultPrivilegeDriftCount).toBe(0);
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
    expect(healthy.dangerousInboundRoleCount).toBe(0);

    await database.unsafe("begin");
    try {
      await database.unsafe(`
        create role acl_inbound_probe;
        grant app_runtime to acl_inbound_probe with inherit true, set false, admin false;
      `);
      const drifted = await snapshot();
      expect(drifted.dangerousInboundRoleCount).toBe(1);
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

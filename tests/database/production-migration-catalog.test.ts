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
});

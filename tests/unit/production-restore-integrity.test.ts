import { describe, expect, it, vi } from "vitest";

import {
  checkProductionRestoreIntegrity,
  collectAppPrivateDataManifest,
  ProductionRestoreIntegrityError,
} from "../../scripts/check-production-restore-integrity";

describe("production restore integrity", () => {
  it("builds a deterministic count and two-part content digest for every application table", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_catalog.pg_class")) return [{ table_name: "games" }];
      return [{ row_count: "2", digest_a: "123", digest_b: "456" }];
    });
    await expect(collectAppPrivateDataManifest(query)).resolves.toEqual([{
      tableName: "games",
      rowCount: "2",
      digestA: "123",
      digestB: "456",
    }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("md5(to_jsonb(record)::text)"));
  });

  it("checks the local identity, exact migrations, RLS, constraints, and every restored table", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("current_database")) return [{ database: "postgres", schema_exists: true }];
      if (text.includes("schema_migrations")) return [{ version: "0001" }, { version: "0002" }];
      if (text.includes("pg_catalog.pg_class")) {
        return [
          { table_name: "games", rls_enabled: true },
          { table_name: "game_names", rls_enabled: true },
        ];
      }
      if (text.includes("pg_catalog.pg_constraint")) return [{ invalid_count: 0 }];
      return [{ row_count: 0 }];
    });

    await expect(checkProductionRestoreIntegrity({
      expectedMigrationVersions: ["0001", "0002"],
      query,
    })).resolves.toBe(6);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('app_private."games"'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('app_private."game_names"'));
  });

  it("rejects a migration ledger mismatch before reading restored rows", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("current_database")) return [{ database: "postgres", schema_exists: true }];
      return [{ version: "0001" }];
    });

    await expect(checkProductionRestoreIntegrity({
      expectedMigrationVersions: ["0001", "0002"],
      query,
    })).rejects.toBeInstanceOf(ProductionRestoreIntegrityError);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

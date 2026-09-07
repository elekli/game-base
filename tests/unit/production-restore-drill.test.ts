import { describe, expect, it } from "vitest";

import {
  PRODUCTION_RESTORE_LOCAL_TARGET,
  ProductionRestoreArtifactProtectionError,
  ProductionRestoreCleanupError,
  ProductionRestoreSourceBindingError,
  ProductionRestoreTargetNotIsolatedError,
  ProductionRestoreVerificationError,
  calculateProductionRestoreSourceBindingFingerprint,
  createProductionRestoreDrill,
  runProductionRestoreDrill,
  type ProductionRestoreAction,
  type ProductionRestoreInput,
  type ProductionRestoreSourceInput,
} from "../../scripts/production-restore-drill";

const PROJECT_REF = "wbtyuvufhrhybquzwfip";
const SESSION_HOST = "aws-0-ap-south-1.pooler.supabase.com";
const DUMP_PATH = "/runner/private/restore-drill/production.dump";

const SOURCE: ProductionRestoreSourceInput = {
  kind: "bound-production-session-pooler",
  host: SESSION_HOST,
  port: 5432,
  database: "postgres",
  user: `postgres.${PROJECT_REF}`,
  sslMode: "verify-full",
  caPath: "/runner/private/prod-ca.pem",
};

const INPUT: ProductionRestoreInput = {
  source: SOURCE,
  runnerTempDir: "/runner/private/restore-drill",
  runnerTempMode: 0o700,
  dumpPath: DUMP_PATH,
  dumpMode: 0o600,
};

function passedResult(action: ProductionRestoreAction) {
  switch (action.kind) {
    case "dump-source":
      return { outcome: "passed" as const, byteLength: 42, sha256: "b".repeat(64) };
    case "restore-dump":
      return { outcome: "passed" as const, restoredSha256: "b".repeat(64) };
    case "verify-integrity":
      return { outcome: "passed" as const, integrityChecks: 7 };
    default:
      return { outcome: "passed" as const };
  }
}

describe("production restore drill", () => {
  it("uses the repository Production binding as the only source trust anchor", () => {
    const allowedSources: ProductionRestoreSourceInput[] = [
      {
        ...SOURCE,
        kind: "bound-production-direct",
        host: `db.${PROJECT_REF}.supabase.co`,
        user: "postgres",
      },
      {
        ...SOURCE,
        kind: "bound-production-direct",
        host: `db.${PROJECT_REF}.supabase.co`,
        user: "app_migrator",
      },
      SOURCE,
      { ...SOURCE, user: `app_migrator.${PROJECT_REF}` },
    ];

    for (const source of allowedSources) {
      const drill = createProductionRestoreDrill({ ...INPUT, source });
      expect(drill.sourceKind).toBe(source.kind);
      expect(drill.source.bindingFingerprint).toBe(
        calculateProductionRestoreSourceBindingFingerprint(source),
      );
      expect(drill.next).toMatchObject({ kind: "dump-source", program: "pg_dump" });
      expect(drill.next).not.toHaveProperty("password");
    }

    const rejectedSources: ProductionRestoreSourceInput[] = [
      { ...SOURCE, host: "aws-0-ap-northeast-1.pooler.supabase.com" },
      { ...SOURCE, host: "aws-0-ap-south-1.pooler.supabase.com.evil.example" },
      { ...SOURCE, host: "aws-0-ap-south-1.pooler.supabase.com", user: "postgres.other-ref" },
      { ...SOURCE, kind: "bound-production-direct", host: SESSION_HOST },
      { ...SOURCE, kind: "bound-production-direct", host: `db.${PROJECT_REF}.supabase.co` },
      { ...SOURCE, kind: "bound-production-session-pooler", host: `db.${PROJECT_REF}.supabase.co` },
      { ...SOURCE, port: 6543 },
      { ...SOURCE, database: "other_database" },
      { ...SOURCE, sslMode: "require" as never },
      { ...SOURCE, caPath: "   " },
    ];

    for (const source of rejectedSources) {
      expect(() => createProductionRestoreDrill({ ...INPUT, source })).toThrow(
        ProductionRestoreSourceBindingError,
      );
    }

    const callerSignedSource = {
      ...SOURCE,
      host: "attacker.example.com",
      bindingFingerprint: calculateProductionRestoreSourceBindingFingerprint({
        ...SOURCE,
        host: "attacker.example.com",
      }),
    };
    expect(() =>
      createProductionRestoreDrill({
        ...INPUT,
        source: callerSignedSource,
        expectedSourceBindingFingerprint: callerSignedSource.bindingFingerprint,
      } as ProductionRestoreInput),
    ).toThrow(ProductionRestoreSourceBindingError);
  });

  it("keeps the local target fixed and rejects every caller override", () => {
    expect(PRODUCTION_RESTORE_LOCAL_TARGET).toEqual({
      host: "127.0.0.1",
      port: 55432,
      database: "puizeru_restore_drill",
      user: "postgres",
    });
    expect(Object.isFrozen(PRODUCTION_RESTORE_LOCAL_TARGET)).toBe(true);
    expect(createProductionRestoreDrill(INPUT).target).toBe(
      PRODUCTION_RESTORE_LOCAL_TARGET,
    );

    const overrides = [
      { ...PRODUCTION_RESTORE_LOCAL_TARGET, port: 5432 },
      { ...PRODUCTION_RESTORE_LOCAL_TARGET, database: "postgres" },
      { ...PRODUCTION_RESTORE_LOCAL_TARGET, user: "arbitrary_local_user" },
    ];
    for (const target of overrides) {
      expect(() =>
        createProductionRestoreDrill({ ...INPUT, target } as ProductionRestoreInput),
      ).toThrow(ProductionRestoreTargetNotIsolatedError);
    }
  });

  it("rejects unprotected or publishable dump artifacts", () => {
    expect(() =>
      createProductionRestoreDrill({ ...INPUT, runnerTempMode: 0o755 }),
    ).toThrow(ProductionRestoreArtifactProtectionError);
    expect(() =>
      createProductionRestoreDrill({ ...INPUT, dumpMode: 0o644 }),
    ).toThrow(ProductionRestoreArtifactProtectionError);
    expect(() =>
      createProductionRestoreDrill({ ...INPUT, dumpPath: "/tmp/public.dump" }),
    ).toThrow(ProductionRestoreArtifactProtectionError);
    expect(() =>
      createProductionRestoreDrill({
        ...INPUT,
        publishedArtifactPath: "artifacts/production.dump",
      }),
    ).toThrow(ProductionRestoreArtifactProtectionError);
  });

  it("plans exact data-only dump, migration replay, restore, verification, and cleanup argv", async () => {
    const actions: ProductionRestoreAction[] = [];
    const final = await runProductionRestoreDrill(createProductionRestoreDrill(INPUT), {
      kind: "fake-local",
      execute: async (action) => {
        actions.push(action);
        return passedResult(action);
      },
    });

    expect(actions).toEqual([
      {
        kind: "dump-source",
        program: "pg_dump",
        argv: [
          "--host",
          SESSION_HOST,
          "--port",
          "5432",
          "--username",
          `postgres.${PROJECT_REF}`,
          "--dbname",
          "postgres",
          "--format=custom",
          "--data-only",
          "--no-owner",
          "--no-privileges",
          "--file",
          DUMP_PATH,
        ],
        environment: {
          PGSSLMODE: "verify-full",
          PGSSLROOTCERT: "/runner/private/prod-ca.pem",
        },
        outputPath: DUMP_PATH,
        outputMode: 0o600,
      },
      {
        kind: "create-local-target",
        program: "createdb",
        argv: [
          "--host",
          "127.0.0.1",
          "--port",
          "55432",
          "--username",
          "postgres",
          "puizeru_restore_drill",
        ],
      },
      {
        kind: "replay-migrations",
        program: "migration-replay",
        argv: [
          "--host",
          "127.0.0.1",
          "--port",
          "55432",
          "--username",
          "postgres",
          "--dbname",
          "puizeru_restore_drill",
        ],
      },
      {
        kind: "restore-dump",
        program: "pg_restore",
        argv: [
          "--host",
          "127.0.0.1",
          "--port",
          "55432",
          "--username",
          "postgres",
          "--dbname",
          "puizeru_restore_drill",
          "--data-only",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          DUMP_PATH,
        ],
        expectedSha256: "b".repeat(64),
      },
      {
        kind: "verify-integrity",
        program: "integrity-check",
        argv: [
          "--host",
          "127.0.0.1",
          "--port",
          "55432",
          "--username",
          "postgres",
          "--dbname",
          "puizeru_restore_drill",
        ],
      },
      {
        kind: "drop-local-target",
        program: "dropdb",
        argv: [
          "--if-exists",
          "--host",
          "127.0.0.1",
          "--port",
          "55432",
          "--username",
          "postgres",
          "puizeru_restore_drill",
        ],
      },
      { kind: "delete-dump", program: "unlink", argv: [DUMP_PATH] },
    ]);
    expect(actions.map(({ kind }) => kind)).not.toContain("rollback-schema");
    expect(
      actions
        .filter(
          (
            action,
          ): action is Exclude<
            ProductionRestoreAction,
            Readonly<{ kind: "stop" }>
          > => action.kind !== "stop",
        )
        .filter((action) => !["dump-source", "delete-dump"].includes(action.kind))
        .every((action) => action.argv.includes("puizeru_restore_drill")),
    ).toBe(true);
    expect(final).toMatchObject({
      phase: "succeeded",
      targetOwnership: "not-owned",
      storageBinariesIncluded: false,
      evidence: {
        outcome: "passed",
        dumpByteLength: 42,
        dumpSha256: "b".repeat(64),
        integrityChecks: 7,
        targetCleaned: true,
        dumpCleaned: true,
        storageBinariesIncluded: false,
      },
    });
  });

  it("deletes only the dump when dumping fails before target ownership", async () => {
    const actions: ProductionRestoreAction[] = [];
    const failed = await runProductionRestoreDrill(createProductionRestoreDrill(INPUT), {
      kind: "fake-local",
      execute: async (action) => {
        actions.push(action);
        if (action.kind === "dump-source") {
          return { outcome: "failed", safeDetail: "dump rejected" };
        }
        return passedResult(action);
      },
    });

    expect(actions.map(({ kind }) => kind)).toEqual([
      "dump-source",
      "delete-dump",
    ]);
    expect(failed).toMatchObject({
      phase: "failed",
      targetOwnership: "not-owned",
      failure: expect.any(ProductionRestoreVerificationError),
    });
  });

  it("does not drop an existing same-name target when createdb fails", async () => {
    const actions: ProductionRestoreAction[] = [];
    const failed = await runProductionRestoreDrill(createProductionRestoreDrill(INPUT), {
      kind: "fake-local",
      execute: async (action) => {
        actions.push(action);
        if (action.kind === "create-local-target") {
          return { outcome: "failed", safeDetail: "database already exists" };
        }
        return passedResult(action);
      },
    });

    expect(actions.map(({ kind }) => kind)).toEqual([
      "dump-source",
      "create-local-target",
      "delete-dump",
    ]);
    expect(failed).toMatchObject({
      phase: "failed",
      targetOwnership: "not-owned",
      failure: expect.any(ProductionRestoreVerificationError),
    });
  });

  it.each([
    "replay-migrations",
    "restore-dump",
    "verify-integrity",
  ] as const)("plans target and dump cleanup when %s fails", async (failedKind) => {
    const actions: ProductionRestoreAction[] = [];
    const failed = await runProductionRestoreDrill(createProductionRestoreDrill(INPUT), {
      kind: "fake-local",
      execute: async (action) => {
        actions.push(action);
        if (action.kind === failedKind) {
          return { outcome: "failed", safeDetail: `${failedKind} rejected` };
        }
        return passedResult(action);
      },
    });

    expect(actions.slice(-2).map(({ kind }) => kind)).toEqual([
      "drop-local-target",
      "delete-dump",
    ]);
    const drop = actions.at(-2);
    expect(drop).toMatchObject({
      kind: "drop-local-target",
      argv: expect.arrayContaining(["puizeru_restore_drill"]),
    });
    if (drop?.kind !== "drop-local-target") {
      throw new Error("drop-local-target cleanup was not planned");
    }
    expect(drop.argv.at(-1)).toBe("puizeru_restore_drill");
    expect(failed).toMatchObject({
      phase: "failed",
      targetOwnership: "not-owned",
    });
    expect(failed.failure).toBeInstanceOf(ProductionRestoreVerificationError);
  });

  it("attempts both cleanups and exposes every cleanup failure", async () => {
    const actions: string[] = [];
    await expect(
      runProductionRestoreDrill(createProductionRestoreDrill(INPUT), {
        kind: "fake-local",
        execute: async (action) => {
          actions.push(action.kind);
          if (action.kind === "replay-migrations") {
            return { outcome: "failed", safeDetail: "migration replay rejected" };
          }
          if (action.kind === "drop-local-target") {
            return { outcome: "failed", safeDetail: "target cleanup rejected" };
          }
          if (action.kind === "delete-dump") {
            return { outcome: "failed", safeDetail: "dump cleanup rejected" };
          }
          return passedResult(action);
        },
      }),
    ).rejects.toMatchObject({
      name: "ProductionRestoreCleanupError",
      safeDetail:
        "target cleanup failed: target cleanup rejected; dump cleanup failed: dump cleanup rejected",
    } satisfies Partial<ProductionRestoreCleanupError>);
    expect(actions).toEqual([
      "dump-source",
      "create-local-target",
      "replay-migrations",
      "drop-local-target",
      "delete-dump",
    ]);
  });
});

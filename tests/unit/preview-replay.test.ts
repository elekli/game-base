import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deploymentBindings,
  hostedBindingsAreMutuallyExclusive,
} from "../../src/shared/config/deployment-bindings";
import {
  PreviewReplayCommandError,
  PreviewReplayConfigurationError,
  PREVIEW_RESET_CONFIRMATION,
  assertMigrationsReplayed,
  buildPreviewReplayPlan,
  previewReplayRecord,
  readMigrationVersions,
  replayHostedPreview,
} from "../../scripts/preview-replay";

const directDatabaseUrl =
  "postgres://postgres:operation-password@db.preview-ref.supabase.co:5432/postgres?sslmode=require";
const commitSha = "defac453716d8396eb9d973fdb4b53bed0a9882e";

const validPlanInput = {
  projectRef: "preview-ref",
  directDatabaseUrl,
  resetConfirmation: PREVIEW_RESET_CONFIRMATION,
  migrationVersions: ["0001", "0002"],
  commitSha,
} as const;

describe("Hosted Preview migration replay", () => {
  it("accepts only the repository-bound Preview direct database", () => {
    const plan = buildPreviewReplayPlan(validPlanInput);

    expect(plan).toEqual({
      projectRef: "preview-ref",
      commitSha,
      migrationVersions: ["0001", "0002"],
      commands: ["reset", "migration-list", "security-tests"],
    });
  });

  it.each([
    ["duplicate versions", ["0001", "0001"]],
    ["out-of-order versions", ["0002", "0001"]],
  ] as const)("rejects %s before any command runs", (_, migrationVersions) => {
    expect(() =>
      buildPreviewReplayPlan({ ...validPlanInput, migrationVersions }),
    ).toThrow(PreviewReplayConfigurationError);
  });

  it.each([
    ["production target", { projectRef: "production-ref" }],
    [
      "pooler URL",
      {
        directDatabaseUrl:
          "postgres://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
      },
    ],
    [
      "production URL",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.production-ref.supabase.co:5432/postgres?sslmode=require",
      },
    ],
    [
      "wrong protocol",
      {
        directDatabaseUrl:
          "postgres+ssl://postgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=require",
      },
    ],
    [
      "wrong username",
      {
        directDatabaseUrl:
          "postgres://admin:x@db.preview-ref.supabase.co:5432/postgres?sslmode=require",
      },
    ],
    [
      "missing password",
      {
        directDatabaseUrl:
          "postgres://postgres@db.preview-ref.supabase.co:5432/postgres?sslmode=require",
      },
    ],
    [
      "wrong port",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:6543/postgres?sslmode=require",
      },
    ],
    [
      "non-canonical port",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:05432/postgres?sslmode=require",
      },
    ],
    [
      "wrong database",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:5432/app?sslmode=require",
      },
    ],
    [
      "non-TLS URL",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=disable",
      },
    ],
    [
      "extra parameter",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=require&x=1",
      },
    ],
    [
      "fragment",
      {
        directDatabaseUrl:
          "postgres://postgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=require#fragment",
      },
    ],
    [
      "encoded username",
      {
        directDatabaseUrl:
          "postgres://%70ostgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=require",
      },
    ],
    ["missing confirmation", { resetConfirmation: "RESET_ANYTHING" }],
    ["missing commit binding", { commitSha: "" }],
  ] as const)("rejects %s before any command runs", (_, override) => {
    expect(() =>
      buildPreviewReplayPlan({ ...validPlanInput, ...override }),
    ).toThrow(PreviewReplayConfigurationError);
  });

  it("rejects a Preview and Production binding that point to the same project", () => {
    const sameProjectBindings = {
      ...deploymentBindings,
      production: {
        ...deploymentBindings.production,
        projectRef: deploymentBindings.preview.projectRef,
        supabaseHostname: deploymentBindings.preview.supabaseHostname,
        supavisorUsername: deploymentBindings.preview.supavisorUsername,
        publishableKeySha256: deploymentBindings.preview.publishableKeySha256,
        secretKeySha256: deploymentBindings.preview.secretKeySha256,
      },
    };

    expect(hostedBindingsAreMutuallyExclusive(sameProjectBindings)).toBe(false);
    expect(() => buildPreviewReplayPlan(validPlanInput, sameProjectBindings)).toThrow(
      PreviewReplayConfigurationError,
    );
  });

  it("creates an allowlisted, commit-bound non-secret replay record", () => {
    const record = previewReplayRecord({
      projectRef: "preview-ref",
      repositoryCommitSha: commitSha,
      migrationVersions: ["0001", "0002"],
      replayedAt: "2026-09-03T00:00:00.000Z",
    });

    expect(record).toEqual({
      environment: "preview",
      projectRef: "preview-ref",
      repositoryCommitSha: commitSha,
      migrationVersions: ["0001", "0002"],
      migrationReplay: "passed",
      securityTests: "passed",
      replayedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(Object.keys(record).sort()).toEqual([
      "environment",
      "migrationReplay",
      "migrationVersions",
      "projectRef",
      "replayedAt",
      "repositoryCommitSha",
      "securityTests",
    ]);
    expect(JSON.stringify(record)).not.toContain("operation-password");
    expect(JSON.stringify(record)).not.toContain("db.preview-ref");
  });

  it("requires migration history to exactly match the ordered repository versions", () => {
    expect(() => assertMigrationsReplayed(["0001", "0002"], ["0001"])).toThrow(
      PreviewReplayCommandError,
    );
    expect(() => assertMigrationsReplayed(["0001", "0002"], ["0002", "0001"])).toThrow(
      PreviewReplayCommandError,
    );
    expect(() => assertMigrationsReplayed(["0002", "0001"], ["0002", "0001"])).toThrow(
      PreviewReplayCommandError,
    );
  });

  it("sorts migration versions numerically and rejects invalid or duplicate files", async () => {
    const migrationsDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    try {
      await writeFile(join(migrationsDirectory, "0002_second.sql"), "select 1;", "utf8");
      await writeFile(join(migrationsDirectory, "0001_first.sql"), "select 1;", "utf8");
      expect(await readMigrationVersions(migrationsDirectory)).toEqual(["0001", "0002"]);

      await writeFile(join(migrationsDirectory, "0002_duplicate.sql"), "select 1;", "utf8");
      await expect(readMigrationVersions(migrationsDirectory)).rejects.toThrow(
        PreviewReplayConfigurationError,
      );
    } finally {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("runs reset without seed, checks history before pgTAP, and writes evidence last", async () => {
    const recordDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    const recordPath = join(recordDirectory, "replay.json");
    const operations: string[] = [];
    const commands: Array<readonly string[]> = [];

    try {
      const record = await replayHostedPreview({
        ...validPlanInput,
        recordPath,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        runCommand: async (operation, args, environment) => {
          operations.push(operation);
          commands.push(args);
          expect(environment.DIRECT_DATABASE_URL).toBeUndefined();
          expect(environment.PREVIEW_DIRECT_DATABASE_URL).toBeUndefined();
          expect(environment.SUPABASE_ACCESS_TOKEN).toBeUndefined();
          expect(environment.SUPABASE_DB_PASSWORD).toBeUndefined();
          expect(environment.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
          expect(environment.PGPASSWORD).toBeUndefined();
          expect(environment.SUPABASE_SECRET_KEY).toBeUndefined();
          return "cli output must not enter evidence";
        },
        readAppliedMigrationVersions: async () => [
          "0001",
          "0002",
          "0003",
          "0004",
          "0005",
          "0006",
        ],
        migrationsDirectory: join(process.cwd(), "supabase/migrations"),
      });

      expect(operations).toEqual(["migration reset", "migration list", "security tests"]);
      expect(commands[0]).toEqual([
        "db",
        "reset",
        "--db-url",
        directDatabaseUrl,
        "--no-seed",
        "--yes",
      ]);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
      expect(JSON.stringify(record)).not.toContain("cli output");
    } finally {
      await rm(recordDirectory, { recursive: true, force: true });
    }
  });

  it("does not run commands or leave evidence when preflight fails", async () => {
    const recordDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    const recordPath = join(recordDirectory, "replay.json");
    const operations: string[] = [];

    try {
      await expect(
        replayHostedPreview({
          ...validPlanInput,
          directDatabaseUrl:
            "postgres://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
          recordPath,
          runCommand: async (operation) => {
            operations.push(operation);
            return "";
          },
        }),
      ).rejects.toThrow(PreviewReplayConfigurationError);
      expect(operations).toEqual([]);
      await expect(readFile(recordPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(recordDirectory, { recursive: true, force: true });
    }
  });

  it("removes stale evidence when a post-reset check fails", async () => {
    const recordDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    const recordPath = join(recordDirectory, "replay.json");
    const operations: string[] = [];
    await writeFile(recordPath, '{"securityTests":"passed"}\n', "utf8");

    try {
      await expect(
        replayHostedPreview({
          ...validPlanInput,
          recordPath,
          runCommand: async (operation) => {
            operations.push(operation);
            return "";
          },
          readAppliedMigrationVersions: async () => ["0001"],
        }),
      ).rejects.toThrow(PreviewReplayCommandError);
      expect(operations).toEqual(["migration reset", "migration list"]);
      await expect(readFile(recordPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(recordDirectory, { recursive: true, force: true });
    }
  });

  it("names an unexpected command failure", async () => {
    await expect(
      replayHostedPreview({
        ...validPlanInput,
        runCommand: async () => {
          throw new Error("unexpected command detail");
        },
        readAppliedMigrationVersions: async () => validPlanInput.migrationVersions,
      }),
    ).rejects.toThrow(PreviewReplayCommandError);
  });

  it("names an unexpected migration history failure", async () => {
    await expect(
      replayHostedPreview({
        ...validPlanInput,
        runCommand: async () => "",
        readAppliedMigrationVersions: async () => {
          throw new Error("unexpected database detail");
        },
      }),
    ).rejects.toThrow(PreviewReplayCommandError);
  });

  it("rejects an evidence path outside the repository before any command", async () => {
    const operations: string[] = [];

    await expect(
      replayHostedPreview({
        ...validPlanInput,
        recordPath: "../outside-preview-replay.json",
        runCommand: async (operation) => {
          operations.push(operation);
          return "";
        },
        readAppliedMigrationVersions: async () => validPlanInput.migrationVersions,
      }),
    ).rejects.toThrow(PreviewReplayConfigurationError);
    expect(operations).toEqual([]);
  });
});

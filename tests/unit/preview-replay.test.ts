import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deploymentBindings } from "../../src/shared/config/deployment-bindings";
import {
  PreviewReplayConfigurationError,
  PreviewReplayCommandError,
  buildPreviewReplayPlan,
  assertMigrationsReplayed,
  replayHostedPreview,
  previewReplayRecord,
  readMigrationVersions,
} from "../../scripts/preview-replay";

const directDatabaseUrl =
  "postgres://postgres:secret@db.preview-ref.supabase.co:5432/postgres?sslmode=require";

describe("Hosted Preview migration replay", () => {
  it("accepts only the repository-bound Preview direct database", () => {
    const plan = buildPreviewReplayPlan({
      projectRef: deploymentBindings.preview.projectRef,
      directDatabaseUrl,
      resetConfirmation: "RESET_PREVIEW_ONLY",
      migrationVersions: ["0001", "0002"],
    });

    expect(plan.projectRef).toBe("preview-ref");
    expect(plan.migrationVersions).toEqual(["0001", "0002"]);
    expect(plan.commands).toEqual(["reset", "migration-list", "security-tests"]);
  });

  it.each([
    ["production target", { projectRef: "production-ref" }],
    ["pooler URL", { directDatabaseUrl: "postgres://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require" }],
    ["non-TLS URL", { directDatabaseUrl: "postgres://postgres:x@db.preview-ref.supabase.co:5432/postgres?sslmode=disable" }],
    ["missing confirmation", { resetConfirmation: "RESET_ANYTHING" }],
  ])("rejects %s before any command runs", (_, override) => {
    expect(() =>
      buildPreviewReplayPlan({
        projectRef: deploymentBindings.preview.projectRef,
        directDatabaseUrl,
        resetConfirmation: "RESET_PREVIEW_ONLY",
        migrationVersions: ["0001"],
        ...override,
      }),
    ).toThrow(PreviewReplayConfigurationError);
  });

  it("creates a non-secret replay record", () => {
    const record = previewReplayRecord({
      projectRef: "preview-ref",
      migrationVersions: ["0001", "0002"],
      replayedAt: "2026-08-30T00:00:00.000Z",
    });

    expect(record).toEqual({
      environment: "preview",
      projectRef: "preview-ref",
      migrationVersions: ["0001", "0002"],
      migrationReplay: "passed",
      securityTests: "passed",
      replayedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("fails when the remote migration history omits a local version", () => {
    expect(() =>
      assertMigrationsReplayed(["0001", "0002"], ["0001"]),
    ).toThrow(PreviewReplayCommandError);
  });

  it("rejects a SQL file that is not a versioned migration", async () => {
    const migrationsDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    await writeFile(join(migrationsDirectory, "not-a-migration.sql"), "select 1;", "utf8");

    await expect(readMigrationVersions(migrationsDirectory)).rejects.toThrow(
      PreviewReplayConfigurationError,
    );
    await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("runs the public replay workflow and writes evidence only after every check passes", async () => {
    const recordDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    const recordPath = join(recordDirectory, "replay.json");
    const operations: string[] = [];
    const originalEnvironment = {
      DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
      PREVIEW_DIRECT_DATABASE_URL: process.env.PREVIEW_DIRECT_DATABASE_URL,
      SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
    };
    process.env.DIRECT_DATABASE_URL = "postgres://postgres:operation-secret@db.prod.example";
    process.env.PREVIEW_DIRECT_DATABASE_URL = directDatabaseUrl;
    process.env.SUPABASE_ACCESS_TOKEN = "operation-token";

    try {
      const record = await replayHostedPreview({
        projectRef: "preview-ref",
        directDatabaseUrl,
        resetConfirmation: "RESET_PREVIEW_ONLY",
        recordPath,
        now: () => new Date("2026-08-30T00:00:00.000Z"),
        runCommand: async (operation, _args, environment) => {
          operations.push(operation);
          expect(environment.DIRECT_DATABASE_URL).toBeUndefined();
          expect(environment.PREVIEW_DIRECT_DATABASE_URL).toBeUndefined();
          expect(environment.SUPABASE_ACCESS_TOKEN).toBeUndefined();
          return "";
        },
        readAppliedMigrationVersions: async () => ["0001", "0002", "0003", "0004", "0005", "0006"],
      });

      expect(operations).toEqual(["migration reset", "migration list", "security tests"]);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
    } finally {
      await rm(recordDirectory, { recursive: true, force: true });
      for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("stops before security tests and does not write evidence after a migration check fails", async () => {
    const recordDirectory = await mkdtemp(join(process.cwd(), ".preview-replay-test-"));
    const recordPath = join(recordDirectory, "replay.json");
    const operations: string[] = [];

    await expect(
      replayHostedPreview({
        projectRef: "preview-ref",
        directDatabaseUrl,
        resetConfirmation: "RESET_PREVIEW_ONLY",
        recordPath,
        runCommand: async (operation) => {
          operations.push(operation);
          return "";
        },
        readAppliedMigrationVersions: async () => ["0001", "0002", "0003", "0004", "0005"],
      }),
    ).rejects.toThrow(PreviewReplayCommandError);

    expect(operations).toEqual(["migration reset", "migration list"]);
    await expect(readFile(recordPath, "utf8")).rejects.toThrow();
    await rm(recordDirectory, { recursive: true, force: true });
  });
});

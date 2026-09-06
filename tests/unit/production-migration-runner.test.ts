import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildReleaseIdentity,
  ProductionMigrationReleaseError,
} from "../../scripts/production-migration-release";
import {
  ProductionMigrationError,
} from "../../scripts/production-migration-preflight";

import {
  SUPABASE_CLI_VERSION,
  assertPinnedSupabaseCli,
  authorizePersistedPlan,
  buildSupabaseApplyInvocation,
  createNormalReleasePorts,
  formatProductionMigrationRunnerFailure,
  parsePersistedPlan,
  persistNormalReleaseRecords,
  runSupabaseApply,
  writeMachineJson,
} from "../../scripts/production-migration-runner";

describe("production migration runner", () => {
  it.each([
    ["ProductionMigrationConnectionError", "Production database connection failed"],
    ["ProductionMigrationPreflightError", "Production database failed checks: grants(unsafe=1,missing=0)"],
    ["ProductionMigrationSafetyError", "migration contains forbidden destructive SQL"],
    ["ProductionMigrationRollbackError", "read-only preflight transaction could not be explicitly rolled back"],
  ] as const)("preserves controlled %s diagnostics without raw failure data", (errorName, safeDetail) => {
    const canary = "postgres://owner:secret@example.test/db CA-CANARY SELECT-sensitive-row";
    const error = new ProductionMigrationError(errorName, safeDetail);
    error.stack = canary;
    Object.assign(error, { cause: new Error(canary), databaseRows: [canary] });

    const diagnostic = formatProductionMigrationRunnerFailure(error);

    expect(diagnostic).toEqual({
      event: "production_migration_runner_failed",
      errorName,
      detail: safeDetail,
    });
    expect(Object.keys(diagnostic).sort()).toEqual(["detail", "errorName", "event"]);
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
  });

  it("keeps unexpected diagnostics generic and drops raw error fields", () => {
    const canary = "postgres://owner:secret@example.test/db CA-CANARY SELECT-sensitive-row";
    const error = new Error(canary, { cause: { sql: canary, rows: [canary] } });

    const diagnostic = formatProductionMigrationRunnerFailure(error);

    expect(diagnostic).toEqual({
      event: "production_migration_runner_failed",
      detail: "inspect protected runner diagnostics",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
  });

  it("retains existing safe release-state diagnostics", () => {
    expect(formatProductionMigrationRunnerFailure(
      new ProductionMigrationReleaseError("candidate is not current main"),
    )).toEqual({
      event: "production_migration_runner_failed",
      detail: "candidate is not current main",
    });
  });

  it("pins Supabase CLI 2.116.0 in package and lock files", async () => {
    expect(SUPABASE_CLI_VERSION).toBe("2.116.0");
    await expect(assertPinnedSupabaseCli(process.cwd())).resolves.toBeUndefined();
  });

  it("passes verify-full CA through PGSSLROOTCERT and exact CLI argv without connecting", async () => {
    const calls: unknown[] = [];
    await runSupabaseApply(process.cwd(), "postgres://bound.example/db?sslmode=verify-full", "/tmp/ca.pem", async (command, args, options) => {
      calls.push({ command, args, ca: options.env.PGSSLROOTCERT });
    });
    expect(calls).toEqual([{
      command: "pnpm",
      args: ["exec", "supabase", "migration", "up", "--db-url", "postgres://bound.example/db?sslmode=verify-full", "--yes", "--log-level", "error"],
      ca: "/tmp/ca.pem",
    }]);
  });

  it("writes machine JSON directly without package-manager stdout headers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migration-runner-"));
    const output = path.join(root, "plan.json");
    await writeMachineJson(output, { pendingMigrations: [] });
    expect(await readFile(output, "utf8")).toBe('{"pendingMigrations":[]}\n');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("fails closed if the package range is not exactly pinned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migration-runner-pin-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { supabase: "^2.116.0" } }));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "specifier: ^2.116.0\nversion: 2.116.0\n");
    await expect(assertPinnedSupabaseCli(root)).rejects.toThrow("exactly pinned");
  });

  it("requires both connection and CA path when constructing apply", () => {
    expect(() => buildSupabaseApplyInvocation("", "/tmp/ca.pem")).toThrow("database URL and CA path are required");
  });

  it("rejects non-canonical persisted plans before the final preflight", () => {
    expect(() => parsePersistedPlan('{ "pendingMigrations": [] }\n', "[]")).toThrow("persisted plan is not canonical");
  });

  it("authorizes an exact persisted attempt without database input", () => {
    const migrations = [{ version: "0007", name: "x", filename: "0007_x.sql", sha256: "a".repeat(64) }];
    const pendingSetSha256 = createHash("sha256").update(JSON.stringify(migrations)).digest("hex");
    const text = `${JSON.stringify({
      pendingMigrations: migrations, pendingSetSha256,
      sourceActor: "operator", sourceRequestedAt: "2026-09-06T10:00:00.000Z",
    })}\n`;
    expect(authorizePersistedPlan(text, '["0007_x.sql"]', {
      runId: "123", runAttempt: 2, candidateSha: "b".repeat(40),
    })).toEqual({ identity: buildReleaseIdentity("123", 2, "b".repeat(40), pendingSetSha256) });
  });

  it("keeps the uploaded plan byte-identical when the apply phase revalidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migration-plan-recheck-"));
    const caPath = path.join(root, "ca.pem");
    const planPath = path.join(root, "plan.json");
    await writeFile(caPath, "certificate");
    const ports = await createNormalReleasePorts({
      root, databaseUrl: "postgres://bound.example/db?sslmode=verify-full", caPath,
      planPath, evidencePath: path.join(root, "evidence.json"), ledgerDirectory: path.join(root, "ledger"), statePath: path.join(root, "state.json"),
      actor: "operator", runId: "123", runAttempt: 2, candidateSha: "b".repeat(40), executionSha: "b".repeat(40),
      pendingInput: '["0007_x.sql"]',
    });
    const migrations = [{ version: "0007", name: "x", filename: "0007_x.sql", sha256: "a".repeat(64) }];
    const first = { migrations, pendingSetSha256: createHash("sha256").update(JSON.stringify(migrations)).digest("hex") };
    await ports.persistPlan(first);
    const persisted = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ sourceActor: "operator" });
    expect(persisted.sourceRequestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(ports.persistPlan(first)).resolves.toBeUndefined();
    await persistNormalReleaseRecords({
      planPath,
      evidencePath: path.join(root, "evidence.json"),
      ledgerDirectory: path.join(root, "ledger"),
      statePath: path.join(root, "state.json"),
      runId: "123", runAttempt: 2, candidateSha: "b".repeat(40), pendingInput: '["0007_x.sql"]',
    }, first);
    const firstEvidence = await readFile(path.join(root, "evidence.json"), "utf8");
    const identity = `${"123-2-"}${"b".repeat(40)}-${first.pendingSetSha256}`;
    const ledgerPath = path.join(root, "ledger", `${identity}.json`);
    const firstLedger = await readFile(ledgerPath, "utf8");
    expect(JSON.parse(firstLedger)).toMatchObject({
      actor: "operator",
      utcTime: persisted.sourceRequestedAt,
      sourceReleaseRun: { id: "123", attempt: 2 },
      successBasis: "strict-exact-target",
      recoveryAction: {
        missingLedgerAfterSuccess: "ledger-recovery",
        incompatibleDatabase: "forward-fix",
        destructiveRollback: "never-reset",
      },
      evidenceSha256: createHash("sha256").update(firstEvidence).digest("hex"),
    });
    await ports.persistSuccess(first);
    expect(await readFile(path.join(root, "evidence.json"), "utf8")).toBe(firstEvidence);
    expect(await readFile(ledgerPath, "utf8")).toBe(firstLedger);
    await expect(ports.persistPlan({ ...first, pendingSetSha256: "d".repeat(64) })).rejects.toThrow("persisted plan changed before apply");
  });
});

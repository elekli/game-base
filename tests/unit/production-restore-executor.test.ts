import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionRestoreDrill,
  runProductionRestoreDrill,
  type ProductionRestoreSourceInput,
} from "../../scripts/production-restore-drill";
import {
  createProductionRestoreExecutor,
  ProductionRestoreCommandError,
  runBoundedCommand,
  type ProductionRestoreCommandInvocation,
} from "../../scripts/production-restore-executor";

const SOURCE: ProductionRestoreSourceInput = {
  kind: "bound-production-session-pooler",
  host: "aws-0-ap-south-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  user: "postgres.wbtyuvufhrhybquzwfip",
  sslMode: "verify-full",
  caPath: "",
};

const workspaces: string[] = [];
const DATA_MANIFEST = [{
  tableName: "games",
  rowCount: "0",
  digestA: "0",
  digestB: "0",
}] as const;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function captureCommandFailure(
  purpose: ProductionRestoreCommandInvocation["purpose"],
  stderr: string,
) {
  let failure: unknown;
  try {
    await runBoundedCommand({
      purpose,
      program: "pnpm",
      argv: ["exec", "node", "-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`],
      cwd: process.cwd(),
      environmentNames: [],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }, {});
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProductionRestoreCommandError);
  return failure as ProductionRestoreCommandError;
}

describe("production restore executor", () => {
  it.each([
    ["permission failure", "pg_restore: error: COPY failed: ERROR: permission denied for table owner_private_game", "permission-denied"],
    ["foreign-key failure", "pg_restore: error: COPY failed: ERROR: owner row violates foreign key constraint owner_relation", "constraint-violation"],
    ["not-null failure", "pg_restore: error: COPY failed: ERROR: null value in column owner_private_field violates not-null constraint", "constraint-violation"],
    ["duplicate data", "pg_restore: error: COPY failed: ERROR: duplicate key value violates unique constraint owner_private_key", "duplicate-data"],
    ["repository trigger invariant", "pg_restore: error: COPY failed: ERROR: verified media derivative violates ledger contract", "trigger-invariant"],
    ["schema drift", "pg_restore: error: could not execute query: ERROR: relation owner_private_game does not exist", "schema-mismatch"],
    ["incompatible archive", "pg_restore: error: unsupported version in file header", "archive-incompatible"],
    ["target connection failure", "pg_restore: error: connection to server at private-host failed", "target-unreachable"],
    ["unknown database rejection", "pg_restore: error: could not execute query: ERROR: owner private payload", "database-rejection"],
    [
      "private context decoy",
      "pg_restore: error: COPY failed for table owner: ERROR: invalid input syntax for type uuid\nCONTEXT: COPY owner, line 1: permission denied",
      "database-rejection",
    ],
    [
      "quoted schema identifier",
      "pg_restore: error: could not execute query: ERROR: relation \"media asset\" does not exist",
      "schema-mismatch",
    ],
    [
      "quoted error marker decoy",
      "pg_restore: error: COPY failed for table \"ERROR: permission denied\": ERROR: invalid input syntax for type uuid",
      "database-rejection",
    ],
  ])("classifies %s without echoing command output", async (_label, privateDetail, category) => {
    const failure = await captureCommandFailure("restore-dump", privateDetail);

    expect(failure.safeDetail).toBe(`restore-dump failed (${category})`);
    expect(failure.message).not.toContain(privateDetail);
  });

  it("does not classify command output outside the restore boundary", async () => {
    const privateDetail = "permission denied for owner_private_integrity_table";
    const failure = await captureCommandFailure("verify-integrity", privateDetail);

    expect(failure.safeDetail).toBe("verify-integrity failed");
    expect(failure.message).not.toContain(privateDetail);
  });

  it("waits for a timed-out process group to exit before rejecting", async () => {
    await expect(runBoundedCommand({
      purpose: "verify-integrity",
      program: "pnpm",
      argv: ["exec", "node", "-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      environmentNames: [],
      timeoutMs: 50,
      maxOutputBytes: 1024,
    }, {})).rejects.toMatchObject({
      safeDetail: "verify-integrity deadline exceeded",
    });
  });

  it("executes a bound dump through an isolated Supabase restore and removes no source data", async () => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    await mkdir(join(runnerTempDir, "supabase", "migrations"), { recursive: true });
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const invocations: ProductionRestoreCommandInvocation[] = [];
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      invocations.push(invocation);
      if (invocation.purpose === "dump-source") {
        const preparedDump = await stat(dumpPath);
        expect(preparedDump.size).toBe(0);
        expect(preparedDump.mode & 0o777).toBe(0o600);
        await writeFile(dumpPath, "bounded-production-data", { mode: 0o600 });
      }
      if (invocation.purpose === "verify-integrity") {
        return {
          stdout: '{"event":"production_restore_integrity_passed","checks":34}\n',
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const drill = createProductionRestoreDrill({
      source: { ...SOURCE, caPath },
      runnerTempDir,
      runnerTempMode: 0o700,
      dumpPath,
      dumpMode: 0o600,
    });

    const result = await runProductionRestoreDrill(
      drill,
      createProductionRestoreExecutor({
        captureSourceSnapshot: async (runDump) => {
          await runDump("fixture-snapshot");
          return DATA_MANIFEST;
        },
        collectTargetManifest: async () => DATA_MANIFEST,
        commandRunner,
        repositoryRoot: process.cwd(),
        runnerTempDir,
        sourcePassword: "source-password-must-not-leak",
      }),
    );

    expect(result).toMatchObject({
      phase: "succeeded",
      evidence: {
        outcome: "passed",
        dumpByteLength: 23,
        integrityChecks: 34,
        targetCleaned: true,
        dumpCleaned: true,
        storageBinariesIncluded: false,
      },
    });
    expect(invocations.map(({ purpose }) => purpose)).toEqual([
      "inspect-client-container",
      "dump-source",
      "inspect-local-target",
      "inspect-local-target",
      "inspect-local-target",
      "create-local-target",
      "replay-migrations",
      "inspect-client-container",
      "clear-local-target-data",
      "inspect-client-container",
      "restore-dump",
      "inspect-client-container",
      "revoke-local-restore-role",
      "verify-integrity",
      "drop-local-target",
    ]);
    const serialized = JSON.stringify(invocations);
    expect(serialized).not.toContain("source-password-must-not-leak");
    expect(serialized).toContain("--schema=app_private");
    expect(serialized).not.toContain("--clean");
    expect(serialized).not.toContain("--create");
    expect(serialized).toContain("ON_ERROR_STOP=1");
    expect(serialized).toContain("begin; grant app_migrator to postgres");
    expect(serialized).toContain("grant app_migrator to postgres");
    expect(serialized).toContain("set role app_migrator");
    expect(serialized).toContain("alter table app_private.production_smoke_canaries no force row level security");
    expect(serialized).toContain("truncate table");
    const clearInvocation = invocations.find(({ purpose }) => purpose === "clear-local-target-data");
    expect(JSON.stringify(clearInvocation)).not.toContain("revoke app_migrator from postgres");
    const restoreInvocation = invocations.find(({ purpose }) => purpose === "restore-dump");
    expect(restoreInvocation?.argv).toContain("--role=app_migrator");
    expect(serialized).toContain("revoke app_migrator from postgres");
    const cleanupInvocation = invocations.find(({ purpose }) => purpose === "revoke-local-restore-role");
    expect(JSON.stringify(cleanupInvocation)).toContain(
      "alter table app_private.production_smoke_canaries force row level security",
    );
    expect(JSON.stringify(cleanupInvocation)).toContain("revoke app_migrator from postgres;");
  });

  it.each([
    {
      label: "restore failure",
      failRestore: true,
      failRevoke: false,
      failClientCleanup: false,
      safeDetail: "restore-dump failed (permission-denied)",
    },
    {
      label: "role cleanup failure",
      failRestore: false,
      failRevoke: true,
      failClientCleanup: false,
      safeDetail: "restore role cleanup failed",
    },
    {
      label: "restore and role cleanup failure",
      failRestore: true,
      failRevoke: true,
      failClientCleanup: false,
      safeDetail: "restore-dump failed (permission-denied); restore role cleanup failed",
    },
    {
      label: "restore and client cleanup failure",
      failRestore: true,
      failRevoke: false,
      failClientCleanup: true,
      safeDetail: "restore-dump failed (permission-denied); isolated client cleanup failed",
    },
  ])("revokes the temporary restore role after $label", async ({ failRestore, failRevoke, failClientCleanup, safeDetail }) => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const purposes: string[] = [];
    let restoreFailed = false;
    let failedClientReported = false;
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      purposes.push(invocation.purpose);
      if (invocation.purpose === "dump-source") {
        await writeFile(dumpPath, "bounded-production-data", { mode: 0o600 });
      }
      if (invocation.purpose === "restore-dump" && failRestore) {
        restoreFailed = true;
        throw new ProductionRestoreCommandError("restore-dump failed (permission-denied)");
      }
      if (
        invocation.purpose === "inspect-client-container" &&
        failClientCleanup && restoreFailed && !failedClientReported
      ) {
        failedClientReported = true;
        return { stdout: "puizeru_restore_load_client\n", stderr: "" };
      }
      if (invocation.purpose === "cleanup-client-container" && failClientCleanup) {
        throw new Error("private client cleanup detail must not leak");
      }
      if (invocation.purpose === "revoke-local-restore-role" && failRevoke) {
        throw new Error("private cleanup detail must not leak");
      }
      return { stdout: "", stderr: "" };
    });
    const result = await runProductionRestoreDrill(
      createProductionRestoreDrill({
        source: { ...SOURCE, caPath }, runnerTempDir, runnerTempMode: 0o700, dumpPath, dumpMode: 0o600,
      }),
      createProductionRestoreExecutor({
        captureSourceSnapshot: async (runDump) => {
          await runDump("fixture-snapshot");
          return DATA_MANIFEST;
        },
        collectTargetManifest: async () => DATA_MANIFEST,
        commandRunner,
        repositoryRoot: process.cwd(),
        runnerTempDir,
        sourcePassword: "source-password-must-not-leak",
      }),
    );

    expect(result).toMatchObject({
      phase: "failed",
      targetOwnership: "not-owned",
      failure: { safeDetail },
    });
    expect(purposes).toContain("revoke-local-restore-role");
    expect(purposes.at(-1)).toBe("drop-local-target");
    expect(JSON.stringify(result)).not.toContain("private cleanup detail must not leak");
    expect(JSON.stringify(result)).not.toContain("private client cleanup detail must not leak");
  });

  it("fails and cleans the target when restored data differs from the exported snapshot", async () => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const purposes: string[] = [];
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      purposes.push(invocation.purpose);
      if (invocation.purpose === "dump-source") {
        await writeFile(dumpPath, "bounded-production-data", { mode: 0o600 });
      }
      if (invocation.purpose === "verify-integrity") {
        return {
          stdout: '{"event":"production_restore_integrity_passed","checks":34}\n',
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const drill = createProductionRestoreDrill({
      source: { ...SOURCE, caPath },
      runnerTempDir,
      runnerTempMode: 0o700,
      dumpPath,
      dumpMode: 0o600,
    });
    const executor = createProductionRestoreExecutor({
      captureSourceSnapshot: async (runDump) => {
        await runDump("fixture-snapshot");
        return DATA_MANIFEST;
      },
      collectTargetManifest: async () => [{ ...DATA_MANIFEST[0], rowCount: "1" }],
      commandRunner,
      repositoryRoot: process.cwd(),
      runnerTempDir,
      sourcePassword: "source-password-must-not-leak",
    });

    const result = await runProductionRestoreDrill(drill, executor);

    expect(result).toMatchObject({ phase: "failed", targetOwnership: "not-owned" });
    expect(purposes.at(-1)).toBe("drop-local-target");
  });

  it("cleans a partially started local target before reporting create failure", async () => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const purposes: string[] = [];
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      purposes.push(invocation.purpose);
      if (invocation.purpose === "dump-source") {
        await writeFile(dumpPath, "bounded-production-data", { mode: 0o600 });
      }
      if (invocation.purpose === "create-local-target") {
        throw new Error("start failed after creating containers");
      }
      return { stdout: "", stderr: "" };
    });
    const drill = createProductionRestoreDrill({
      source: { ...SOURCE, caPath },
      runnerTempDir,
      runnerTempMode: 0o700,
      dumpPath,
      dumpMode: 0o600,
    });

    const result = await runProductionRestoreDrill(
      drill,
      createProductionRestoreExecutor({
        captureSourceSnapshot: async (runDump) => {
          await runDump("fixture-snapshot");
          return DATA_MANIFEST;
        },
        collectTargetManifest: async () => DATA_MANIFEST,
        commandRunner,
        repositoryRoot: process.cwd(),
        runnerTempDir,
        sourcePassword: "source-password-must-not-leak",
      }),
    );

    expect(purposes).toEqual([
      "inspect-client-container",
      "dump-source",
      "inspect-local-target",
      "inspect-local-target",
      "inspect-local-target",
      "create-local-target",
      "cleanup-partial-target",
    ]);
    expect(result).toMatchObject({ phase: "failed", targetOwnership: "not-owned" });
  });

  it("rejects an existing client container without removing it", async () => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const purposes: string[] = [];
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      purposes.push(invocation.purpose);
      return {
        stdout: invocation.purpose === "inspect-client-container" ? "puizeru_restore_dump_client\n" : "",
        stderr: "",
      };
    });
    const result = await runProductionRestoreDrill(
      createProductionRestoreDrill({
        source: { ...SOURCE, caPath },
        runnerTempDir,
        runnerTempMode: 0o700,
        dumpPath,
        dumpMode: 0o600,
      }),
      createProductionRestoreExecutor({
        captureSourceSnapshot: async (runDump) => {
          await runDump("fixture-snapshot");
          return DATA_MANIFEST;
        },
        collectTargetManifest: async () => DATA_MANIFEST,
        commandRunner,
        repositoryRoot: process.cwd(),
        runnerTempDir,
        sourcePassword: "source-password-must-not-leak",
      }),
    );

    expect(result).toMatchObject({ phase: "failed", targetOwnership: "not-owned" });
    expect(purposes).toEqual(["inspect-client-container"]);
  });

  it("rejects a stopped target's retained volume without starting or deleting it", async () => {
    const runnerTempDir = await mkdtemp(join(tmpdir(), "production-restore-executor-"));
    workspaces.push(runnerTempDir);
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, "fixture-ca", { mode: 0o600 });
    const invocations: ProductionRestoreCommandInvocation[] = [];
    const commandRunner = vi.fn(async (invocation: ProductionRestoreCommandInvocation) => {
      invocations.push(invocation);
      if (invocation.purpose === "dump-source") {
        await writeFile(dumpPath, "bounded-production-data", { mode: 0o600 });
      }
      return {
        stdout: invocation.argv[0] === "volume" ? "supabase_db_puizeru-restore-drill\n" : "",
        stderr: "",
      };
    });
    const result = await runProductionRestoreDrill(
      createProductionRestoreDrill({
        source: { ...SOURCE, caPath }, runnerTempDir, runnerTempMode: 0o700, dumpPath, dumpMode: 0o600,
      }),
      createProductionRestoreExecutor({
        captureSourceSnapshot: async (runDump) => {
          await runDump("fixture-snapshot");
          return DATA_MANIFEST;
        },
        collectTargetManifest: async () => DATA_MANIFEST,
        commandRunner,
        repositoryRoot: process.cwd(),
        runnerTempDir,
        sourcePassword: "source-password-must-not-leak",
      }),
    );

    expect(result).toMatchObject({ phase: "failed", targetOwnership: "not-owned" });
    expect(invocations.some(({ purpose }) => purpose === "create-local-target")).toBe(false);
    expect(invocations.some(({ purpose }) => purpose === "cleanup-partial-target")).toBe(false);
  });
});

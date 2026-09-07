import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

describe("production restore executor", () => {
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
      "verify-integrity",
      "drop-local-target",
    ]);
    const serialized = JSON.stringify(invocations);
    expect(serialized).not.toContain("source-password-must-not-leak");
    expect(serialized).toContain("--schema=app_private");
    expect(serialized).not.toContain("--clean");
    expect(serialized).not.toContain("--create");
    expect(serialized).toContain("truncate table");
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

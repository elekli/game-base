import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import postgres from "postgres";

import { collectAppPrivateDataManifest, type AppPrivateDataManifest } from "./check-production-restore-integrity";

import {
  type ProductionRestoreAction,
  type ProductionRestoreExecutorResult,
  type ProductionRestoreLocalExecutor,
} from "./production-restore-drill";

const POSTGRES_CLIENT_IMAGE =
  "public.ecr.aws/supabase/postgres:17.6.1.166@sha256:b3bfedb107413abb3b8cb0d0874b0414a1dceb3d55bc0c778de6ad22d1f7dc86";
const LOCAL_PROJECT_ID = "puizeru-restore-drill";
const LOCAL_CONTAINER = `supabase_db_${LOCAL_PROJECT_ID}`;
const LOCAL_NETWORK = `supabase_network_${LOCAL_PROJECT_ID}`;
const DUMP_CLIENT_CONTAINER = "puizeru_restore_dump_client";
const RESTORE_CLIENT_CONTAINER = "puizeru_restore_load_client";
const MAX_COMMAND_OUTPUT_BYTES = 65_536;

export class ProductionRestoreCommandError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionRestoreCommandError: ${safeDetail}`);
    this.name = "ProductionRestoreCommandError";
  }
}

export type ProductionRestoreCommandInvocation = Readonly<{
  purpose:
    | Exclude<ProductionRestoreAction["kind"], "stop" | "delete-dump">
    | "inspect-local-target"
    | "cleanup-partial-target"
    | "inspect-client-container"
    | "cleanup-client-container";
  program: "docker" | "pnpm";
  argv: ReadonlyArray<string>;
  cwd: string;
  environmentNames: ReadonlyArray<string>;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

type SensitiveEnvironment = Readonly<Record<string, string>>;

export type ProductionRestoreCommandRunner = (
  invocation: ProductionRestoreCommandInvocation,
  sensitiveEnvironment: SensitiveEnvironment,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type ProductionRestoreIsolatedExecutor = ProductionRestoreLocalExecutor & Readonly<{
  emergencyCleanup(): Promise<void>;
}>;

export async function runBoundedCommand(
  invocation: ProductionRestoreCommandInvocation,
  sensitiveEnvironment: SensitiveEnvironment,
) {
  return new Promise<Readonly<{ stdout: string; stderr: string }>>(
    (resolvePromise, reject) => {
      const inheritedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          !/(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|CA_CERT|PRIVATE_KEY|COOKIE|AUTH)/i.test(name),
        ),
      );
      const child = spawn(invocation.program, [...invocation.argv], {
        cwd: invocation.cwd,
        env: {
          ...inheritedEnvironment,
          NODE_ENV: process.env.NODE_ENV ?? "production",
          ...sensitiveEnvironment,
        },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let terminationDetail: string | undefined;
      const timer: { current?: NodeJS.Timeout } = {};
      const forceTimer: { current?: NodeJS.Timeout } = {};
      const processGroupExists = () => {
        if (!child.pid || process.platform === "win32") return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const finish = (
        callback: () => void,
      ) => {
        if (settled) return;
        settled = true;
        if (timer.current) clearTimeout(timer.current);
        if (forceTimer.current) clearTimeout(forceTimer.current);
        callback();
      };
      const confirmForcedExit = (deadline: number) => {
        if (!processGroupExists()) {
          finish(() => reject(new ProductionRestoreCommandError(terminationDetail!)));
          return;
        }
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        if (Date.now() >= deadline) {
          finish(() => reject(new ProductionRestoreCommandError(
            `${invocation.purpose} process-group cleanup could not be confirmed`,
          )));
          return;
        }
        forceTimer.current = setTimeout(() => confirmForcedExit(deadline), 50);
      };
      const terminate = (safeDetail: string) => {
        if (terminationDetail) return;
        terminationDetail = safeDetail;
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else child.kill("SIGTERM");
        forceTimer.current = setTimeout(
          () => confirmForcedExit(Date.now() + 5_000),
          2_000,
        );
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > invocation.maxOutputBytes) {
          terminate(`${invocation.purpose} output exceeded its bound`);
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", () => finish(() => reject(
        new ProductionRestoreCommandError(`${invocation.purpose} could not start`),
      )));
      child.on("close", (code) => {
        if (terminationDetail && processGroupExists()) return;
        finish(() => {
          if (terminationDetail) reject(new ProductionRestoreCommandError(terminationDetail));
          else if (code === 0) resolvePromise({ stdout, stderr });
          else reject(new ProductionRestoreCommandError(`${invocation.purpose} failed`));
        });
      });
      timer.current = setTimeout(() => {
        terminate(`${invocation.purpose} deadline exceeded`);
      }, invocation.timeoutMs);
    },
  );
}

function assertInside(path: string, parent: string) {
  const child = resolve(path);
  const root = resolve(parent);
  const offset = relative(root, child);
  if (!offset || offset.startsWith("..") || resolve(root, offset) !== child) {
    throw new ProductionRestoreCommandError("restore artifact path is outside the private workspace");
  }
}

async function digestFile(path: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new ProductionRestoreCommandError("restore dump is empty or has an unsafe mode");
  }
  return { byteLength: metadata.size, sha256: hash.digest("hex") };
}

function invocation(
  config: Readonly<{ repositoryRoot: string }>,
  purpose: ProductionRestoreCommandInvocation["purpose"],
  program: ProductionRestoreCommandInvocation["program"],
  argv: ReadonlyArray<string>,
  environmentNames: ReadonlyArray<string>,
  timeoutMs: number,
): ProductionRestoreCommandInvocation {
  return {
    purpose,
    program,
    argv,
    cwd: config.repositoryRoot,
    environmentNames,
    timeoutMs,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function replaceArgument(
  argv: ReadonlyArray<string>,
  flag: string,
  value: string,
) {
  const copy = [...argv];
  const index = copy.indexOf(flag);
  if (index < 0 || index + 1 >= copy.length) {
    throw new ProductionRestoreCommandError("restore action arguments are invalid");
  }
  copy[index + 1] = value;
  return copy;
}

export function createProductionRestoreExecutor({
  captureSourceSnapshot,
  collectTargetManifest,
  commandRunner = runBoundedCommand,
  repositoryRoot,
  runnerTempDir,
  sourcePassword,
}: Readonly<{
  captureSourceSnapshot?: (runDump: (snapshotId: string) => Promise<void>) => Promise<AppPrivateDataManifest>;
  collectTargetManifest?: () => Promise<AppPrivateDataManifest>;
  commandRunner?: ProductionRestoreCommandRunner;
  repositoryRoot: string;
  runnerTempDir: string;
  sourcePassword: string;
}>): ProductionRestoreIsolatedExecutor {
  if (!isAbsolute(repositoryRoot) || !isAbsolute(runnerTempDir) || !sourcePassword) {
    throw new ProductionRestoreCommandError("restore executor configuration is incomplete");
  }
  let targetMayExist = false;
  let sourceManifest: AppPrivateDataManifest | undefined;
  const ownedClients = new Set<string>();
  const stopTarget = async (purpose: "cleanup-partial-target" | "drop-local-target") => {
    await commandRunner(
      invocation(
        { repositoryRoot },
        purpose,
        "pnpm",
        ["exec", "supabase", "stop", "--no-backup", "--workdir", runnerTempDir],
        [],
        120_000,
      ),
      {},
    );
    targetMayExist = false;
  };
  const clientExists = async (containerName: string) => {
    const result = await commandRunner(
      invocation(
        { repositoryRoot },
        "inspect-client-container",
        "docker",
        ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.Names}}"],
        [],
        30_000,
      ),
      {},
    );
    return result.stdout.trim() !== "";
  };
  const removeClientIfPresent = async (containerName: string) => {
    if (!await clientExists(containerName)) return;
    await commandRunner(
      invocation(
        { repositoryRoot },
        "cleanup-client-container",
        "docker",
        ["rm", "--force", containerName],
        [],
        30_000,
      ),
      {},
    );
  };
  const runFreshClient = async (
    containerName: string,
    command: ProductionRestoreCommandInvocation,
    sensitiveEnvironment: SensitiveEnvironment,
  ) => {
    if (await clientExists(containerName)) {
      throw new ProductionRestoreCommandError("isolated restore client container already exists");
    }
    ownedClients.add(containerName);
    try {
      await commandRunner(command, sensitiveEnvironment);
      ownedClients.delete(containerName);
    } catch (error) {
      await removeClientIfPresent(containerName);
      ownedClients.delete(containerName);
      throw error;
    }
  };
  const execute = async (
    action: Exclude<ProductionRestoreAction, { kind: "stop" }>,
  ): Promise<ProductionRestoreExecutorResult> => {
    try {
      if (action.kind === "delete-dump") {
        assertInside(action.argv[0] ?? "", runnerTempDir);
        await rm(action.argv[0]!, { force: true });
        return { outcome: "passed" };
      }
      if (action.kind === "dump-source") {
        assertInside(action.outputPath, runnerTempDir);
        assertInside(action.environment.PGSSLROOTCERT, runnerTempDir);
        const containerDumpPath = `/runner/${basename(action.outputPath)}`;
        const containerCaPath = `/runner/${basename(action.environment.PGSSLROOTCERT)}`;
        const runDump = async (snapshotId: string) => {
          const dumpArgv = replaceArgument(action.argv, "--file", containerDumpPath);
          dumpArgv.splice(dumpArgv.indexOf("--file"), 0, `--snapshot=${snapshotId}`);
          await runFreshClient(
            DUMP_CLIENT_CONTAINER,
            invocation(
                { repositoryRoot },
                action.kind,
                "docker",
                [
                  "run", "--rm", "--name", DUMP_CLIENT_CONTAINER,
                  "--env", "PGPASSWORD",
                  "--env", "PGSSLMODE=verify-full",
                  "--env", `PGSSLROOTCERT=${containerCaPath}`,
                  "--mount", `type=bind,source=${runnerTempDir},target=/runner`,
                  POSTGRES_CLIENT_IMAGE,
                  "pg_dump",
                  ...dumpArgv,
                ],
                ["PGPASSWORD"],
                300_000,
            ),
            { PGPASSWORD: sourcePassword },
          );
        };
        if (captureSourceSnapshot) {
          sourceManifest = await captureSourceSnapshot(runDump);
        } else {
          const ca = await readFile(action.environment.PGSSLROOTCERT, "utf8");
          const sourceSql = postgres({
            host: action.argv[action.argv.indexOf("--host") + 1],
            port: Number(action.argv[action.argv.indexOf("--port") + 1]),
            database: action.argv[action.argv.indexOf("--dbname") + 1],
            username: action.argv[action.argv.indexOf("--username") + 1],
            password: sourcePassword,
            ssl: { ca, rejectUnauthorized: true },
            max: 1,
            prepare: false,
            connect_timeout: 30,
          });
          try {
            await sourceSql.begin("isolation level repeatable read read only", async (transaction) => {
              const snapshotRows = await transaction.unsafe<{ snapshot_id: string }[]>("select pg_export_snapshot() as snapshot_id");
              const snapshotId = snapshotRows[0]?.snapshot_id;
              if (!snapshotId) throw new ProductionRestoreCommandError("Production snapshot could not be exported");
              sourceManifest = await collectAppPrivateDataManifest(async (text) => transaction.unsafe(text));
              await runDump(snapshotId);
            });
          } finally {
            await sourceSql.end({ timeout: 5 });
          }
        }
        return { outcome: "passed", ...(await digestFile(action.outputPath)) };
      }
      if (action.kind === "create-local-target") {
        const resourceInspections = await Promise.all([
          ["ps", "-a", "--filter", `name=${LOCAL_PROJECT_ID}`, "--format", "{{.Names}}"],
          ["volume", "ls", "--filter", `name=${LOCAL_PROJECT_ID}`, "--format", "{{.Name}}"],
          ["network", "ls", "--filter", `name=${LOCAL_PROJECT_ID}`, "--format", "{{.Name}}"],
        ].map((argv) => commandRunner(
          invocation({ repositoryRoot }, "inspect-local-target", "docker", argv, [], 30_000),
          {},
        )));
        if (resourceInspections.some((inspection) => inspection.stdout.trim() !== "")) {
          throw new ProductionRestoreCommandError("isolated restore target already exists");
        }
        targetMayExist = true;
        try {
          await commandRunner(
            invocation(
              { repositoryRoot },
              action.kind,
              "pnpm",
              ["exec", "supabase", ...action.argv],
              [],
              300_000,
            ),
            {},
          );
        } catch (startError) {
          try {
            await stopTarget("cleanup-partial-target");
          } catch {
            throw new ProductionRestoreCommandError("local target start and partial cleanup failed");
          }
          throw startError;
        }
        return { outcome: "passed" };
      }
      if (action.kind === "replay-migrations" || action.kind === "drop-local-target") {
        if (action.kind === "drop-local-target") await stopTarget(action.kind);
        else await commandRunner(
          invocation({ repositoryRoot }, action.kind, "pnpm", ["exec", "supabase", ...action.argv], [], 300_000),
          {},
        );
        return { outcome: "passed" };
      }
      if (action.kind === "clear-local-target-data") {
        const clearSql = "do $$ declare tables text; begin select string_agg(format('%I.%I', schemaname, tablename), ', ') into tables from pg_catalog.pg_tables where schemaname = 'app_private'; if tables is not null then execute 'truncate table ' || tables || ' restart identity cascade'; end if; end $$;";
        await runFreshClient(
          RESTORE_CLIENT_CONTAINER,
          invocation(
            { repositoryRoot },
            action.kind,
            "docker",
            [
              "run", "--rm", "--name", RESTORE_CLIENT_CONTAINER,
              "--network", LOCAL_NETWORK,
              "--env", "PGPASSWORD",
              POSTGRES_CLIENT_IMAGE,
              "psql",
              ...replaceArgument(replaceArgument(action.argv, "--host", LOCAL_CONTAINER), "--port", "5432"),
              "--command", clearSql,
            ],
            ["PGPASSWORD"],
            120_000,
          ),
          { PGPASSWORD: "postgres" },
        );
        return { outcome: "passed" };
      }
      if (action.kind === "restore-dump") {
        assertInside(action.argv.at(-1) ?? "", runnerTempDir);
        let restoreArgv = replaceArgument(action.argv, "--host", LOCAL_CONTAINER);
        restoreArgv = replaceArgument(restoreArgv, "--port", "5432");
        restoreArgv[restoreArgv.length - 1] = `/runner/${basename(action.argv.at(-1)!)}`;
        await runFreshClient(
          RESTORE_CLIENT_CONTAINER,
          invocation(
            { repositoryRoot },
            action.kind,
            "docker",
            [
              "run", "--rm", "--name", RESTORE_CLIENT_CONTAINER,
              "--network", LOCAL_NETWORK,
              "--env", "PGPASSWORD",
              "--mount", `type=bind,source=${runnerTempDir},target=/runner,readonly`,
              POSTGRES_CLIENT_IMAGE,
              "pg_restore",
              ...restoreArgv,
            ],
            ["PGPASSWORD"],
            300_000,
          ),
          { PGPASSWORD: "postgres" },
        );
        const digest = await digestFile(action.argv.at(-1)!);
        return { outcome: "passed", restoredSha256: digest.sha256 };
      }
      const { stdout } = await commandRunner(
        invocation(
          { repositoryRoot },
          action.kind,
          "pnpm",
          ["release:restore:integrity"],
          ["DIRECT_DATABASE_URL"],
          120_000,
        ),
        {
          DIRECT_DATABASE_URL:
            "postgres://postgres:postgres@127.0.0.1:55432/postgres",
        },
      );
      const line = stdout.trim().split("\n").at(-1);
      const parsed = line ? JSON.parse(line) as unknown : undefined;
      if (
        typeof parsed !== "object" || parsed === null ||
        (parsed as Record<string, unknown>).event !== "production_restore_integrity_passed" ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).checks)
      ) throw new ProductionRestoreCommandError("integrity evidence is invalid");
      if (!sourceManifest) throw new ProductionRestoreCommandError("Production snapshot manifest is unavailable");
      let targetManifest: AppPrivateDataManifest;
      if (collectTargetManifest) targetManifest = await collectTargetManifest();
      else {
        const targetSql = postgres("postgres://postgres:postgres@127.0.0.1:55432/postgres", {
          max: 1,
          prepare: false,
          connect_timeout: 10,
        });
        try {
          targetManifest = await collectAppPrivateDataManifest(async (text) => targetSql.unsafe(text));
        } finally {
          await targetSql.end({ timeout: 5 });
        }
      }
      if (JSON.stringify(targetManifest) !== JSON.stringify(sourceManifest)) {
        throw new ProductionRestoreCommandError("restored application data does not match the Production snapshot");
      }
      return {
        outcome: "passed",
        integrityChecks: (parsed as { checks: number }).checks,
      };
    } catch (error) {
      return {
        outcome: "failed",
        safeDetail: error instanceof ProductionRestoreCommandError
          ? error.safeDetail
          : `${action.kind} failed`,
      };
    }
  };
  return {
    kind: "isolated-local",
    execute,
    emergencyCleanup: async () => {
      for (const containerName of ownedClients) await removeClientIfPresent(containerName);
      if (targetMayExist) await stopTarget("cleanup-partial-target");
    },
  };
}

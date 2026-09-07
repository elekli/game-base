import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { deploymentBindings } from "../src/shared/config/deployment-bindings";
import { createProductionRestoreDrill, runProductionRestoreDrill, type ProductionRestoreSourceInput } from "./production-restore-drill";
import { createProductionRestoreExecutor } from "./production-restore-executor";

export class ProductionRestoreConfigurationError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionRestoreConfigurationError: ${safeDetail}`);
    this.name = "ProductionRestoreConfigurationError";
  }
}

function readSafeDetail(error: unknown, fallback: string) {
  if (
    typeof error === "object" && error !== null &&
    "safeDetail" in error && typeof error.safeDetail === "string"
  ) return error.safeDetail;
  return fallback;
}

function assertInside(path: string, parent: string) {
  const child = resolve(path);
  const root = resolve(parent);
  const offset = relative(root, child);
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
    throw new ProductionRestoreConfigurationError("restore output path is outside the runner workspace");
  }
}

export function parseProductionRestoreSource(databaseUrl: string, caPath: string): Readonly<{
  source: ProductionRestoreSourceInput;
  password: string;
}> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ProductionRestoreConfigurationError("Production database URL is invalid");
  }
  const binding = deploymentBindings.production;
  const directHost = `db.${binding.projectRef}.supabase.co`;
  const kind = url.hostname === directHost
    ? "bound-production-direct"
    : url.hostname === binding.supavisorHost
      ? "bound-production-session-pooler"
      : undefined;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    kind === undefined ||
    url.port !== "5432" ||
    url.pathname !== `/${binding.databaseName}` ||
    user === "" ||
    password === "" ||
    caPath === ""
  ) {
    throw new ProductionRestoreConfigurationError("Production database URL is not the bound 5432 restore source");
  }
  return {
    source: {
      kind,
      host: url.hostname,
      port: 5432,
      database: binding.databaseName,
      user,
      sslMode: "verify-full",
      caPath,
    },
    password,
  };
}

export function createIsolatedSupabaseConfig(source: string) {
  const configured = source
    .replace('project_id = "puizeru-gamebase"', 'project_id = "puizeru-restore-drill"')
    .replaceAll("5432", "5543");
  if (
    !configured.includes('project_id = "puizeru-restore-drill"') ||
    !configured.includes("port = 55432") ||
    !configured.includes("shadow_port = 55430")
  ) {
    throw new ProductionRestoreConfigurationError("isolated Supabase configuration could not be prepared");
  }
  return configured;
}

export async function runProductionRestore({
  caCertificate,
  databaseUrl,
  evidencePath,
  repositoryRoot,
  runnerRoot,
}: Readonly<{
  caCertificate: string;
  databaseUrl: string;
  evidencePath: string;
  repositoryRoot: string;
  runnerRoot: string;
}>) {
  if (!isAbsolute(repositoryRoot) || !isAbsolute(runnerRoot) || !isAbsolute(evidencePath)) {
    throw new ProductionRestoreConfigurationError("restore paths must be absolute");
  }
  assertInside(evidencePath, runnerRoot);
  const previousUmask = process.umask(0o077);
  const runnerTempDir = await mkdtemp(join(runnerRoot, "production-restore-private-"));
  let succeeded = false;
  let primaryFailure: ProductionRestoreConfigurationError | undefined;
  let executor: ReturnType<typeof createProductionRestoreExecutor> | undefined;
  try {
    const supabaseDir = join(runnerTempDir, "supabase");
    await mkdir(supabaseDir, { recursive: true, mode: 0o700 });
    const sourceConfig = await readFile(join(repositoryRoot, "supabase", "config.toml"), "utf8");
    await writeFile(join(supabaseDir, "config.toml"), createIsolatedSupabaseConfig(sourceConfig), { mode: 0o600 });
    await cp(join(repositoryRoot, "supabase", "migrations"), join(supabaseDir, "migrations"), { recursive: true });
    await cp(join(repositoryRoot, "supabase", "seed.sql"), join(supabaseDir, "seed.sql"));
    const caPath = join(runnerTempDir, "production-ca.pem");
    const dumpPath = join(runnerTempDir, "production.dump");
    await writeFile(caPath, caCertificate, { mode: 0o600 });
    const { source, password } = parseProductionRestoreSource(databaseUrl, caPath);
    executor = createProductionRestoreExecutor({
      repositoryRoot,
      runnerTempDir,
      sourcePassword: password,
    });
    const final = await runProductionRestoreDrill(
      createProductionRestoreDrill({
        source,
        runnerTempDir,
        runnerTempMode: 0o700,
        dumpPath,
        dumpMode: 0o600,
      }),
      executor,
    );
    if (final.phase !== "succeeded" || !final.evidence) {
      throw new ProductionRestoreConfigurationError(
        final.failure?.safeDetail ?? "Production restore drill did not pass",
      );
    }
    await rm(runnerTempDir, { force: true, recursive: true });
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, `${JSON.stringify(final.evidence, null, 2)}\n`, { mode: 0o600 });
    succeeded = true;
    return final.evidence;
  } catch (error) {
    primaryFailure = error instanceof ProductionRestoreConfigurationError
      ? error
      : new ProductionRestoreConfigurationError(
          readSafeDetail(error, "Production restore drill failed"),
        );
    throw primaryFailure;
  } finally {
    const cleanupFailures: string[] = [];
    try {
      if (!succeeded) {
        try {
          await executor?.emergencyCleanup();
        } catch (error) {
          cleanupFailures.push(
            `emergency cleanup failed: ${readSafeDetail(error, "cleanup outcome is unknown")}`,
          );
        }
      }
    } finally {
      try {
        await rm(runnerTempDir, { force: true, recursive: true });
      } catch {
        cleanupFailures.push("private workspace cleanup failed");
      }
      process.umask(previousUmask);
    }
    if (cleanupFailures.length > 0) {
      const prior = primaryFailure ? `${primaryFailure.safeDetail}; ` : "";
      throw new ProductionRestoreConfigurationError(`${prior}${cleanupFailures.join("; ")}`);
    }
  }
}

async function main() {
  const repositoryRoot = process.cwd();
  const runnerRoot = process.env.RUNNER_TEMP ?? tmpdir();
  const evidencePath = process.env.RESTORE_EVIDENCE_PATH;
  const databaseUrl = process.env.PRODUCTION_MIGRATION_DATABASE_URL;
  const caCertificate = process.env.PRODUCTION_MIGRATION_CA_CERT;
  if (!evidencePath || !databaseUrl || !caCertificate) {
    throw new ProductionRestoreConfigurationError("protected restore inputs are incomplete");
  }
  const evidence = await runProductionRestore({
    caCertificate,
    databaseUrl,
    evidencePath,
    repositoryRoot,
    runnerRoot,
  });
  console.log(JSON.stringify({
    event: "production_restore_drill_passed",
    integrityChecks: evidence.integrityChecks,
    storageBinariesIncluded: evidence.storageBinariesIncluded,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safeDetail = error instanceof ProductionRestoreConfigurationError
      ? error.safeDetail
      : "Production restore drill failed";
    console.error(JSON.stringify({ event: "production_restore_drill_failed", safeDetail }));
    process.exitCode = 1;
  });
}

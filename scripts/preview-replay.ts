import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { deploymentBindings } from "../src/shared/config/deployment-bindings";
import { NamedError } from "../src/shared/errors/named-error";

const run = promisify(execFile);
const confirmation = "RESET_PREVIEW_ONLY";
const defaultRecordPath = "docs/deployment/evidence/preview-supabase-replay.json";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export class PreviewReplayConfigurationError extends NamedError {
  constructor() {
    super("preview_replay_configuration_invalid", "Preview 重播設定無效。");
    this.name = "PreviewReplayConfigurationError";
  }
}

export class PreviewReplayCommandError extends NamedError {
  constructor(operation: string) {
    super("preview_replay_command_failed", `Preview ${operation} 失敗。`);
    this.name = "PreviewReplayCommandError";
  }
}

type PreviewReplayInput = Readonly<{
  projectRef: string;
  directDatabaseUrl: string;
  resetConfirmation: string;
  migrationVersions: readonly string[];
}>;

type PreviewReplayCommandRunner = (
  operation: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

type MigrationHistoryReader = (databaseUrl: string) => Promise<readonly string[]>;

export type PreviewReplayPlan = Readonly<{
  projectRef: string;
  migrationVersions: readonly string[];
  commands: readonly ["reset", "migration-list", "security-tests"];
}>;

export type PreviewReplayRecord = Readonly<{
  environment: "preview";
  projectRef: string;
  migrationVersions: readonly string[];
  migrationReplay: "passed";
  securityTests: "passed";
  replayedAt: string;
}>;

function rejectConfiguration(): never {
  throw new PreviewReplayConfigurationError();
}

function validateDirectDatabaseUrl(value: string, projectRef: string): void {
  let url: URL;
  let username: string;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
  } catch {
    rejectConfiguration();
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    username !== "postgres" ||
    url.password.length === 0 ||
    url.hostname !== `db.${projectRef}.supabase.co` ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.searchParams.get("sslmode") !== "require"
  ) {
    rejectConfiguration();
  }
}

export function buildPreviewReplayPlan(input: PreviewReplayInput): PreviewReplayPlan {
  const binding = deploymentBindings.preview;
  if (
    input.projectRef !== binding.projectRef ||
    input.resetConfirmation !== confirmation ||
    input.migrationVersions.length === 0 ||
    input.migrationVersions.some((version) => !/^\d{4,}$/.test(version))
  ) {
    rejectConfiguration();
  }
  validateDirectDatabaseUrl(input.directDatabaseUrl, binding.projectRef);

  return {
    projectRef: input.projectRef,
    migrationVersions: [...input.migrationVersions],
    commands: ["reset", "migration-list", "security-tests"],
  };
}

export function assertMigrationsReplayed(
  expected: readonly string[],
  applied: readonly string[],
): void {
  if (expected.length !== applied.length || expected.some((version, index) => version !== applied[index])) {
    throw new PreviewReplayCommandError("migration history");
  }
}

export function previewReplayRecord(input: Readonly<{
  projectRef: string;
  migrationVersions: readonly string[];
  replayedAt: string;
}>): PreviewReplayRecord {
  return {
    environment: "preview",
    projectRef: input.projectRef,
    migrationVersions: [...input.migrationVersions],
    migrationReplay: "passed",
    securityTests: "passed",
    replayedAt: input.replayedAt,
  };
}

export async function readMigrationVersions(
  migrationsDirectory = `${repositoryRoot}supabase/migrations`,
): Promise<readonly string[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  const versions = sqlFiles.map((entry) => /^(\d{4,})_[^/]+\.sql$/.exec(entry.name)?.[1] ?? null);
  if (versions.some((version) => version === null)) throw new PreviewReplayConfigurationError();

  const resolvedVersions = versions.filter((version): version is string => version !== null);
  if (resolvedVersions.length === 0 || new Set(resolvedVersions).size !== resolvedVersions.length) {
    throw new PreviewReplayConfigurationError();
  }
  resolvedVersions.sort();
  return resolvedVersions;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "DIRECT_DATABASE_URL",
    "PREVIEW_DIRECT_DATABASE_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PGPASSWORD",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function runSupabase(operation: string, args: readonly string[]): Promise<string> {
  const environment = sanitizedEnvironment();

  try {
    const result = await run("supabase", [...args], {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch {
    throw new PreviewReplayCommandError(operation);
  }
}

async function readRemoteMigrationVersions(databaseUrl: string): Promise<readonly string[]> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await client.unsafe<{ version: string }[]>(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    return rows.map((row) => row.version);
  } catch {
    throw new PreviewReplayCommandError("migration history");
  } finally {
    await client.end();
  }
}

export async function replayHostedPreview(input: Readonly<{
  projectRef: string;
  directDatabaseUrl: string;
  resetConfirmation: string;
  recordPath?: string;
  now?: () => Date;
  runCommand?: PreviewReplayCommandRunner;
  migrationsDirectory?: string;
  readAppliedMigrationVersions?: MigrationHistoryReader;
}>): Promise<PreviewReplayRecord> {
  const migrationVersions = await readMigrationVersions(input.migrationsDirectory);
  const plan = buildPreviewReplayPlan({ ...input, migrationVersions });
  const databaseArgument = ["--db-url", input.directDatabaseUrl];
  const commandRunner = input.runCommand ?? (async (operation, args) => runSupabase(operation, args));

  await commandRunner(
    "migration reset",
    ["db", "reset", ...databaseArgument, "--no-seed", "--yes"],
    sanitizedEnvironment(),
  );
  await commandRunner(
    "migration list",
    ["migration", "list", ...databaseArgument],
    sanitizedEnvironment(),
  );
  const appliedMigrations = await (
    input.readAppliedMigrationVersions ?? readRemoteMigrationVersions
  )(input.directDatabaseUrl);
  assertMigrationsReplayed(plan.migrationVersions, appliedMigrations);
  await commandRunner(
    "security tests",
    ["test", "db", ...databaseArgument],
    sanitizedEnvironment(),
  );

  const record = previewReplayRecord({
    projectRef: plan.projectRef,
    migrationVersions: plan.migrationVersions,
    replayedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const recordPath = input.recordPath ?? defaultRecordPath;
  const absoluteRecordPath = resolve(repositoryRoot, recordPath);
  if (!absoluteRecordPath.startsWith(repositoryRoot)) throw new PreviewReplayConfigurationError();
  await mkdir(dirname(absoluteRecordPath), { recursive: true });
  await writeFile(absoluteRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRef = process.env.PREVIEW_PROJECT_REF;
  const directDatabaseUrl = process.env.PREVIEW_DIRECT_DATABASE_URL;
  const resetConfirmation = process.env.PREVIEW_RESET_CONFIRMATION;
  if (!projectRef || !directDatabaseUrl || !resetConfirmation) throw new PreviewReplayConfigurationError();

  await replayHostedPreview({ projectRef, directDatabaseUrl, resetConfirmation });
  console.log(JSON.stringify({ event: "preview_supabase_replay_passed", projectRef }));
}

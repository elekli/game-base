import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { deploymentBindings, hostedBindingsAreMutuallyExclusive, type DeploymentBinding } from "../src/shared/config/deployment-bindings";
import { NamedError } from "../src/shared/errors/named-error";

const run = promisify(execFile);
export const PREVIEW_RESET_CONFIRMATION = "RESET_PREVIEW_ONLY";
export const DEFAULT_RECORD_PATH = "docs/deployment/evidence/preview-supabase-replay.json";
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationFilePattern = /^(\d{4,})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
const commitShaPattern = /^[0-9a-f]{40}$/;
const safeCommandEnvironmentNames = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKSPACE",
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
] as const;

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

export type PreviewReplayInput = Readonly<{
  projectRef: string;
  directDatabaseUrl: string;
  resetConfirmation: string;
  migrationVersions: readonly string[];
  commitSha: string;
}>;

type PreviewReplayCommandRunner = (
  operation: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

type MigrationHistoryReader = (databaseUrl: string) => Promise<readonly string[]>;

export type PreviewReplayPlan = Readonly<{
  projectRef: string;
  commitSha: string;
  migrationVersions: readonly string[];
  commands: readonly ["reset", "migration-list", "security-tests"];
}>;

export type PreviewReplayRecord = Readonly<{
  environment: "preview";
  projectRef: string;
  repositoryCommitSha: string;
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
  try {
    url = new URL(value);
  } catch {
    rejectConfiguration();
  }

  if (
    url.toString() !== value ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username !== "postgres" ||
    url.password.length === 0 ||
    url.hostname !== `db.${projectRef}.supabase.co` ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.search !== "?sslmode=require" ||
    url.hash !== ""
  ) {
    rejectConfiguration();
  }
}

function validateCommitSha(value: string): void {
  if (!commitShaPattern.test(value)) rejectConfiguration();
}

export function buildPreviewReplayPlan(
  input: PreviewReplayInput,
  bindings: Readonly<Record<"preview" | "production", DeploymentBinding>> = deploymentBindings,
): PreviewReplayPlan {
  const binding = bindings.preview;
  if (
    !hostedBindingsAreMutuallyExclusive(bindings) ||
    input.projectRef !== binding.projectRef ||
    input.resetConfirmation !== PREVIEW_RESET_CONFIRMATION ||
    !migrationVersionsAreStrictlyOrdered(input.migrationVersions)
  ) {
    rejectConfiguration();
  }
  validateCommitSha(input.commitSha);
  validateDirectDatabaseUrl(input.directDatabaseUrl, binding.projectRef);

  return {
    projectRef: input.projectRef,
    commitSha: input.commitSha,
    migrationVersions: [...input.migrationVersions],
    commands: ["reset", "migration-list", "security-tests"],
  };
}

export function assertMigrationsReplayed(
  expected: readonly string[],
  applied: readonly string[],
): void {
  if (
    !migrationVersionsAreStrictlyOrdered(expected) ||
    expected.length !== applied.length ||
    expected.some((version, index) => version !== applied[index])
  ) {
    throw new PreviewReplayCommandError("migration history");
  }
}

export function previewReplayRecord(input: Readonly<{
  projectRef: string;
  repositoryCommitSha: string;
  migrationVersions: readonly string[];
  replayedAt: string;
}>): PreviewReplayRecord {
  validateCommitSha(input.repositoryCommitSha);
  return {
    environment: "preview",
    projectRef: input.projectRef,
    repositoryCommitSha: input.repositoryCommitSha,
    migrationVersions: [...input.migrationVersions],
    migrationReplay: "passed",
    securityTests: "passed",
    replayedAt: input.replayedAt,
  };
}

function compareMigrationVersions(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function migrationVersionsAreStrictlyOrdered(versions: readonly string[]): boolean {
  return (
    versions.length > 0 &&
    versions.every((version, index) => {
      if (!/^\d{4,}$/.test(version)) return false;
      return index === 0 || compareMigrationVersions(versions[index - 1], version) < 0;
    })
  );
}

export async function readMigrationVersions(
  migrationsDirectory = resolve(repositoryRoot, "supabase/migrations"),
): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch {
    throw new PreviewReplayConfigurationError();
  }

  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  const versions = sqlFiles.map((entry) => entry.name.match(migrationFilePattern)?.[1] ?? null);
  if (versions.some((version) => version === null)) throw new PreviewReplayConfigurationError();

  const resolvedVersions = versions.filter((version): version is string => version !== null);
  if (resolvedVersions.length === 0 || new Set(resolvedVersions).size !== resolvedVersions.length) {
    throw new PreviewReplayConfigurationError();
  }
  resolvedVersions.sort(compareMigrationVersions);
  return resolvedVersions;
}

function replayCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const name of safeCommandEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function runSupabase(operation: string, args: readonly string[]): Promise<string> {
  try {
    const result = await run("supabase", [...args], {
      cwd: repositoryRoot,
      env: replayCommandEnvironment(),
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch {
    throw new PreviewReplayCommandError(operation);
  }
}

async function executeReplayCommand(
  commandRunner: PreviewReplayCommandRunner,
  operation: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await commandRunner(operation, args, environment);
  } catch (error) {
    if (error instanceof PreviewReplayCommandError) throw error;
    throw new PreviewReplayCommandError(operation);
  }
}

async function readRemoteMigrationVersions(databaseUrl: string): Promise<readonly string[]> {
  let client: ReturnType<typeof postgres> | undefined;
  try {
    client = postgres(databaseUrl, { max: 1, prepare: false });
    const rows = await client.unsafe<{ version: string }[]>(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    return rows.map((row) => row.version);
  } catch {
    throw new PreviewReplayCommandError("migration history");
  } finally {
    if (client !== undefined) {
      try {
        await client.end();
      } catch {
        throw new PreviewReplayCommandError("migration history");
      }
    }
  }
}

function resolveRecordPath(recordPath: string): string {
  const absoluteRecordPath = resolve(repositoryRoot, recordPath);
  const recordRelativePath = relative(repositoryRoot, absoluteRecordPath);
  if (
    recordRelativePath === "" ||
    recordRelativePath === ".." ||
    recordRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(recordRelativePath)
  ) {
    throw new PreviewReplayConfigurationError();
  }
  return absoluteRecordPath;
}

async function removeExistingRecord(recordPath: string): Promise<void> {
  try {
    await unlink(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PreviewReplayCommandError("evidence cleanup");
    }
  }
}

async function writeReplayEvidence(
  recordPath: string,
  record: PreviewReplayRecord,
): Promise<void> {
  const temporaryRecordPath = `${recordPath}.${process.pid}.tmp`;
  await removeExistingRecord(temporaryRecordPath);
  try {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(temporaryRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporaryRecordPath, recordPath);
  } catch {
    try {
      await unlink(temporaryRecordPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PreviewReplayCommandError("evidence cleanup");
      }
    }
    throw new PreviewReplayCommandError("evidence write");
  }
}

export async function replayHostedPreview(input: Readonly<{
  projectRef: string;
  directDatabaseUrl: string;
  resetConfirmation: string;
  commitSha: string;
  recordPath?: string;
  now?: () => Date;
  runCommand?: PreviewReplayCommandRunner;
  migrationsDirectory?: string;
  readAppliedMigrationVersions?: MigrationHistoryReader;
}>): Promise<PreviewReplayRecord> {
  const absoluteRecordPath = resolveRecordPath(input.recordPath ?? DEFAULT_RECORD_PATH);
  await removeExistingRecord(absoluteRecordPath);
  const migrationVersions = await readMigrationVersions(input.migrationsDirectory);
  const plan = buildPreviewReplayPlan({ ...input, migrationVersions });
  const databaseArgument = ["--db-url", input.directDatabaseUrl];
  const commandRunner = input.runCommand ?? (async (operation, args) => runSupabase(operation, args));
  const commandEnvironment = replayCommandEnvironment();

  await executeReplayCommand(
    commandRunner,
    "migration reset",
    ["db", "reset", ...databaseArgument, "--no-seed", "--yes"],
    commandEnvironment,
  );
  await executeReplayCommand(
    commandRunner,
    "migration list",
    ["migration", "list", ...databaseArgument],
    commandEnvironment,
  );
  let appliedMigrations: readonly string[];
  try {
    appliedMigrations = await (
      input.readAppliedMigrationVersions ?? readRemoteMigrationVersions
    )(input.directDatabaseUrl);
  } catch (error) {
    if (error instanceof PreviewReplayCommandError) throw error;
    throw new PreviewReplayCommandError("migration history");
  }
  assertMigrationsReplayed(plan.migrationVersions, appliedMigrations);
  await executeReplayCommand(
    commandRunner,
    "security tests",
    ["test", "db", ...databaseArgument],
    commandEnvironment,
  );

  const record = previewReplayRecord({
    projectRef: plan.projectRef,
    repositoryCommitSha: plan.commitSha,
    migrationVersions: plan.migrationVersions,
    replayedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  await writeReplayEvidence(absoluteRecordPath, record);
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRef = process.env.PREVIEW_PROJECT_REF;
  const directDatabaseUrl = process.env.PREVIEW_DIRECT_DATABASE_URL;
  const resetConfirmation = process.env.PREVIEW_RESET_CONFIRMATION;
  const commitSha = process.env.PREVIEW_REPLAY_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (!projectRef || !directDatabaseUrl || !resetConfirmation || !commitSha) {
    throw new PreviewReplayConfigurationError();
  }

  await replayHostedPreview({ projectRef, directDatabaseUrl, resetConfirmation, commitSha });
  console.log(JSON.stringify({ event: "preview_supabase_replay_passed", projectRef, commitSha }));
}

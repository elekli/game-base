import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { runProductionMigrationPreflight } from "./production-migration-preflight";
import {
  buildReleaseRecords,
  buildReleaseIdentity,
  completePreparedNormalMigrationRelease,
  assertPendingMigrationPlan,
  prepareNormalMigrationRelease,
  ProductionMigrationReleaseError,
  publishLedgerPullRequest,
  runLedgerRecovery,
  type NormalMigrationReleasePorts,
} from "./production-migration-release";

const execFileAsync = promisify(execFile);
export const SUPABASE_CLI_VERSION = "2.116.0";

export function buildSupabaseApplyInvocation(databaseUrl: string, caPath: string) {
  if (!databaseUrl || !caPath) throw new Error("ProductionMigrationRunnerError: database URL and CA path are required");
  return {
    command: "pnpm",
    args: ["exec", "supabase", "migration", "up", "--db-url", databaseUrl, "--yes", "--log-level", "error"],
    env: { PGSSLROOTCERT: caPath },
  } as const;
}

export async function assertPinnedSupabaseCli(root: string): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
  const lock = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
  if (
    packageJson.devDependencies?.supabase !== SUPABASE_CLI_VERSION ||
    !lock.includes(`specifier: ${SUPABASE_CLI_VERSION}`) ||
    !lock.includes(`version: ${SUPABASE_CLI_VERSION}`)
  ) throw new Error("ProductionMigrationRunnerError: Supabase CLI must be exactly pinned");
}

export async function runSupabaseApply(
  root: string,
  databaseUrl: string,
  caPath: string,
  execute: (command: string, args: readonly string[], options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>) => Promise<void> = async (command, args, options) => {
    await execFileAsync(command, [...args], options);
  },
): Promise<void> {
  await assertPinnedSupabaseCli(root);
  const invocation = buildSupabaseApplyInvocation(databaseUrl, caPath);
  await execute(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, ...invocation.env },
  });
}

export async function writeMachineJson(pathname: string, value: unknown): Promise<void> {
  await writeFile(pathname, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function resolveMain(root: string, executionSha: string): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(executionSha)) throw new Error("ProductionMigrationRunnerError: execution commit must be a full lowercase SHA");
  await execFileAsync("git", ["fetch", "--no-tags", "origin", "main"], { cwd: root });
  const main = (await execFileAsync("git", ["rev-parse", "origin/main"], { cwd: root })).stdout.trim();
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (head !== executionSha) throw new Error("ProductionMigrationRunnerError: checkout is not the verified execution commit");
  if (main !== executionSha) throw new Error("ProductionMigrationRunnerError: execution commit is no longer current main");
  return main;
}

export async function createNormalReleasePorts(input: Readonly<{
  root: string;
  databaseUrl: string;
  caPath: string;
  planPath: string;
  evidencePath: string;
  ledgerDirectory: string;
  statePath: string;
  actor: string;
  runId: string;
  runAttempt: number;
  candidateSha: string;
  executionSha: string;
  pendingInput: string;
}>): Promise<NormalMigrationReleasePorts> {
  const caCertificate = await readFile(input.caPath, "utf8");
  const sourceActor = validateSourceActor(input.actor);
  const sourceRequestedAt = new Date().toISOString();
  return {
    resolveMain: () => resolveMain(input.root, input.executionSha),
    preflight: () => runProductionMigrationPreflight({ root: input.root, databaseUrl: input.databaseUrl, caCertificate, phase: "pre-apply" }),
    persistPlan: async (plan) => {
      const text = `${JSON.stringify({
        pendingMigrations: plan.migrations,
        pendingSetSha256: plan.pendingSetSha256,
        sourceActor,
        sourceRequestedAt,
      })}\n`;
      try {
        if (await readFile(input.planPath, "utf8") !== text) throw new Error("ProductionMigrationRunnerError: persisted plan changed before apply");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeFile(input.planPath, text, { mode: 0o600 });
      }
    },
    apply: () => runSupabaseApply(input.root, input.databaseUrl, input.caPath),
    strictVerify: async () => { await runProductionMigrationPreflight({ root: input.root, databaseUrl: input.databaseUrl, caCertificate, phase: "strict" }); },
    persistSuccess: (plan) => persistNormalReleaseRecords(input, plan),
  };
}

export async function persistNormalReleaseRecords(
  input: Readonly<{
    planPath: string;
    evidencePath: string;
    ledgerDirectory: string;
    statePath: string;
    runId: string;
    runAttempt: number;
    candidateSha: string;
    pendingInput: string;
  }>,
  plan: Readonly<{ migrations: ReadonlyArray<Readonly<{ version: string; name: string; filename: string; sha256: string }>>; pendingSetSha256: string }>,
): Promise<void> {
  const persisted = parsePersistedPlan(await readFile(input.planPath, "utf8"), input.pendingInput);
  if (JSON.stringify(persisted.plan) !== JSON.stringify(plan)) {
    throw new Error("ProductionMigrationRunnerError: persisted plan changed after apply");
  }
  const expectedIdentity = buildReleaseIdentity(input.runId, input.runAttempt, input.candidateSha, plan.pendingSetSha256);
  const records = buildReleaseRecords({
    commit: input.candidateSha, actor: persisted.sourceActor, runId: input.runId,
    runAttempt: input.runAttempt, releaseIdentity: expectedIdentity,
    result: "success", pendingMigrations: plan.migrations,
    pendingSetSha256: plan.pendingSetSha256, utcTime: persisted.sourceRequestedAt,
  });
  await mkdir(input.ledgerDirectory, { recursive: true });
  await mkdir(path.dirname(input.evidencePath), { recursive: true });
  const ledgerPath = path.join(input.ledgerDirectory, `${expectedIdentity}.json`);
  await writeFile(input.evidencePath, records.evidenceText, { mode: 0o600 });
  try {
    if (await readFile(ledgerPath, "utf8") !== records.ledgerText) {
      throw new Error("ProductionMigrationRunnerError: ledger identity already has different evidence");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(ledgerPath, records.ledgerText, { mode: 0o600 });
  }
  await writeMachineJson(input.statePath, { identity: expectedIdentity, ledgerPath });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ProductionMigrationRunnerError: ${name} is required`);
  return value;
}

function validateSourceActor(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_\[\]-]{1,100}$/.test(value)) {
    throw new Error("ProductionMigrationRunnerError: source actor is invalid");
  }
  return value;
}

function validateSourceRequestedAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("ProductionMigrationRunnerError: source requested time is invalid");
  }
  return value;
}

export function parsePersistedPlan(text: string, pendingInput: string) {
  let parsed: {
    pendingMigrations?: unknown;
    pendingSetSha256?: unknown;
    sourceActor?: unknown;
    sourceRequestedAt?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("ProductionMigrationRunnerError: persisted plan is not valid JSON");
  }
  if (`${JSON.stringify(parsed)}\n` !== text || JSON.stringify(Object.keys(parsed)) !== JSON.stringify([
    "pendingMigrations", "pendingSetSha256", "sourceActor", "sourceRequestedAt",
  ])) {
    throw new Error("ProductionMigrationRunnerError: persisted plan is not canonical");
  }
  return {
    plan: assertPendingMigrationPlan(pendingInput, parsed),
    sourceActor: validateSourceActor(parsed.sourceActor),
    sourceRequestedAt: validateSourceRequestedAt(parsed.sourceRequestedAt),
  };
}

export function authorizePersistedPlan(
  text: string,
  pendingInput: string,
  source: Readonly<{ runId: string; runAttempt: number; candidateSha: string }>,
) {
  const { plan } = parsePersistedPlan(text, pendingInput);
  return { identity: buildReleaseIdentity(source.runId, source.runAttempt, source.candidateSha, plan.pendingSetSha256) };
}

async function runRecoveryFromEnvironment(root: string): Promise<void> {
  const runId = requiredEnvironment("SOURCE_RUN_ID");
  const runAttempt = Number(requiredEnvironment("SOURCE_RUN_ATTEMPT"));
  const runRaw = JSON.parse(await readFile(requiredEnvironment("SOURCE_RUN_PATH"), "utf8")) as {
    id?: unknown; run_attempt?: unknown; repository?: { full_name?: unknown }; path?: unknown; event?: unknown; head_sha?: unknown;
  };
  const jobsRaw = JSON.parse(await readFile(requiredEnvironment("SOURCE_JOBS_PATH"), "utf8")) as {
    jobs?: Array<{ id?: unknown; name?: unknown; run_attempt?: unknown; steps?: Array<{ name?: unknown; conclusion?: unknown }> }>;
  };
  const artifactRaw = JSON.parse(await readFile(requiredEnvironment("SOURCE_ARTIFACT_PATH"), "utf8")) as { name?: unknown; digest?: unknown };
  const archive = await readFile(requiredEnvironment("SOURCE_ARTIFACT_ZIP_PATH"));
  const planText = await readFile(requiredEnvironment("SOURCE_PLAN_PATH"), "utf8");
  const persistedSourcePlan = parsePersistedPlan(planText, requiredEnvironment("PENDING_INPUT"));
  const caCertificate = await readFile(requiredEnvironment("PGSSLROOTCERT"), "utf8");
  const databaseUrl = requiredEnvironment("PRODUCTION_MIGRATION_DATABASE_URL");
  const executionSha = requiredEnvironment("EXECUTION_SHA");
  let expectedLedgerText = "";
  let expectedEvidenceText = "";
  let recoveryIdentity = "";
  let recoveryLedgerPath = "";
  await runLedgerRecovery({
    resolveMain: () => resolveMain(root, executionSha),
    isAncestor: async (ancestor, descendant) => {
      try { await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root }); return true; } catch { return false; }
    },
    loadSourceRun: async () => ({
      id: String(runRaw.id), runAttempt: Number(runRaw.run_attempt),
      repository: String(runRaw.repository?.full_name), workflowPath: String(runRaw.path),
      event: String(runRaw.event), headSha: String(runRaw.head_sha),
    }),
    loadSourceJobs: async () => (jobsRaw.jobs ?? []).map((job) => ({
      id: Number(job.id), name: String(job.name), runAttempt: Number(job.run_attempt),
      steps: (job.steps ?? []).map((step) => ({ name: String(step.name), conclusion: String(step.conclusion) })),
    })),
    loadPlanArtifact: async () => {
      const expectedName = `production-migration-plan-${runId}-${runAttempt}`;
      if (artifactRaw.name !== expectedName) throw new Error("ProductionMigrationRunnerError: source artifact identity mismatch");
      return {
        text: planText, metadataDigest: String(artifactRaw.digest),
        downloadedArchiveDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
        runAttempt,
      };
    },
    readMigrationAtSource: async (commit, filename) => execFileSync("git", ["show", `${commit}:supabase/migrations/${filename}`], { cwd: root }),
    readMigrationAtExecution: async (commit, filename) => execFileSync("git", ["show", `${commit}:supabase/migrations/${filename}`], { cwd: root }),
    recoveryStrictVerify: async ({ plan }) => {
      const verified = await runProductionMigrationPreflight({ root, databaseUrl, caCertificate, phase: "recovery" });
      const filenames = (await readdir(path.join(root, "supabase", "migrations"))).filter((name) => name.endsWith(".sql")).sort();
      const requiredTail = Math.max(...plan.migrations.map((migration) => filenames.indexOf(migration.filename)));
      if (requiredTail < 0 || verified.appliedMigrationCount <= requiredTail) throw new Error("ProductionMigrationRunnerError: source migration set is not an applied Production prefix");
    },
    persistLedger: async ({ identity, sourceSha, plan }) => {
      const records = buildReleaseRecords({
        commit: sourceSha, actor: persistedSourcePlan.sourceActor, runId,
        runAttempt, releaseIdentity: identity, result: "success",
        pendingMigrations: plan.migrations, pendingSetSha256: plan.pendingSetSha256,
        utcTime: persistedSourcePlan.sourceRequestedAt,
      });
      expectedLedgerText = records.ledgerText;
      expectedEvidenceText = records.evidenceText;
      const ledgerDirectory = requiredEnvironment("RELEASE_LEDGER_DIRECTORY");
      await mkdir(ledgerDirectory, { recursive: true });
      const ledgerPath = path.join(ledgerDirectory, `${identity}.json`);
      recoveryIdentity = identity;
      recoveryLedgerPath = ledgerPath;
      try { return (await readFile(ledgerPath, "utf8")) === expectedLedgerText ? "same" : "different"; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeFile(ledgerPath, expectedLedgerText, { mode: 0o600 });
        return "created";
      }
    },
  }, {
    sourceRunId: runId, sourceRunAttempt: runAttempt,
    pendingInput: requiredEnvironment("PENDING_INPUT"),
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    workflowPath: ".github/workflows/production-release.yml",
    sourceSha: requiredEnvironment("SOURCE_SHA"),
    executionSha,
  });
  if (!recoveryIdentity || !recoveryLedgerPath || !expectedEvidenceText) {
    throw new Error("ProductionMigrationRunnerError: recovery did not produce release state");
  }
  const evidencePath = requiredEnvironment("RELEASE_EVIDENCE_PATH");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, expectedEvidenceText, { mode: 0o600 });
  await writeMachineJson(requiredEnvironment("RELEASE_STATE_PATH"), { identity: recoveryIdentity, ledgerPath: recoveryLedgerPath });
}

async function readGitObject(root: string, revision: string, pathname: string): Promise<string | null> {
  try { return (await execFileAsync("git", ["show", `${revision}:${pathname}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })).stdout; }
  catch { return null; }
}

async function publishLedgerFromEnvironment(root: string): Promise<void> {
  const state = JSON.parse(await readFile(requiredEnvironment("RELEASE_STATE_PATH"), "utf8")) as { identity?: unknown; ledgerPath?: unknown };
  const identity = String(state.identity);
  const ledgerPath = String(state.ledgerPath);
  const ledgerText = await readFile(ledgerPath, "utf8");
  await publishLedgerPullRequest({
    readMainLedger: (pathname) => readGitObject(root, "origin/main", pathname),
    readBranchLedger: async (branch, pathname) => {
      try {
        await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { cwd: root });
      } catch (error) {
        if ((error as NodeJS.ErrnoException & { code?: number }).code === 2) return { branchExists: false, ledgerText: null };
        throw error;
      }
      try {
        await execFileAsync("git", ["fetch", "--no-tags", "origin", `${branch}:refs/remotes/origin/${branch}`], { cwd: root });
      } catch (error) { throw error; }
      return { branchExists: true, ledgerText: await readGitObject(root, `origin/${branch}`, pathname) };
    },
    listPullRequests: async (branch) => {
      const output = await execFileAsync("gh", ["pr", "list", "--state", "all", "--head", branch, "--limit", "100", "--json", "headRefName,baseRefName,title,state,isDraft,mergedAt"], { cwd: root });
      const rows = JSON.parse(output.stdout) as Array<{
        headRefName?: unknown; baseRefName?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; mergedAt?: unknown;
      }>;
      return rows.map((row) => {
        if (
          !["OPEN", "CLOSED", "MERGED"].includes(String(row.state)) ||
          typeof row.isDraft !== "boolean" ||
          !(row.mergedAt === null || typeof row.mergedAt === "string")
        ) throw new Error("ProductionMigrationRunnerError: pull request evidence is invalid");
        return {
          head: String(row.headRefName), base: String(row.baseRefName), title: String(row.title),
          state: String(row.state) as "OPEN" | "CLOSED" | "MERGED",
          isDraft: row.isDraft, mergedAt: row.mergedAt,
        };
      });
    },
    createBranch: async (branch, pathname) => {
      await execFileAsync("git", ["switch", "-c", branch], { cwd: root });
      await execFileAsync("git", ["add", "--", pathname], { cwd: root });
      await execFileAsync("git", ["-c", "user.name=github-actions", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", `chore: record production migration ${identity}`], { cwd: root });
      await execFileAsync("git", ["push", "origin", branch], { cwd: root });
    },
    createPullRequest: async (branch) => {
      await execFileAsync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore: record production migration ${identity}`, "--body", `Sanitized commit-bound migration ledger for ${identity}.`], { cwd: root });
    },
  }, { identity, ledgerPath, ledgerText });
}

async function main() {
  const mode = process.argv[2];
  const root = process.cwd();
  if (mode === "publish-ledger") {
    await publishLedgerFromEnvironment(root);
    console.log(JSON.stringify({ event: "production_migration_ledger_published" }));
    return;
  }
  if (mode === "recovery") {
    await runRecoveryFromEnvironment(root);
    console.log(JSON.stringify({ event: "production_migration_recovery_succeeded" }));
    return;
  }
  if (mode !== "apply" && mode !== "preflight" && mode !== "authorize" && mode !== "record") throw new Error("ProductionMigrationRunnerError: unknown mode");
  const releaseInput = {
    candidateSha: requiredEnvironment("CANDIDATE_SHA"),
    executionSha: requiredEnvironment("EXECUTION_SHA"),
    pendingInput: requiredEnvironment("PENDING_INPUT"),
  };
  const planPath = requiredEnvironment("RELEASE_PLAN_PATH");
  if (mode === "authorize") {
    const authorization = authorizePersistedPlan(
      await readFile(planPath, "utf8"),
      releaseInput.pendingInput,
      {
        runId: requiredEnvironment("GITHUB_RUN_ID"),
        runAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
        candidateSha: releaseInput.candidateSha,
      },
    );
    console.log(JSON.stringify({ event: "production_migration_attempt_authorized", ...authorization }));
    return;
  }
  if (mode === "record") {
    const { plan } = parsePersistedPlan(await readFile(planPath, "utf8"), releaseInput.pendingInput);
    await persistNormalReleaseRecords({
      planPath,
      evidencePath: requiredEnvironment("RELEASE_EVIDENCE_PATH"),
      ledgerDirectory: requiredEnvironment("RELEASE_LEDGER_DIRECTORY"),
      statePath: requiredEnvironment("RELEASE_STATE_PATH"),
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      runAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
      candidateSha: releaseInput.candidateSha,
      pendingInput: releaseInput.pendingInput,
    }, plan);
    console.log(JSON.stringify({ event: "production_migration_records_created" }));
    return;
  }
  const ports = await createNormalReleasePorts({
    root,
    databaseUrl: requiredEnvironment("PRODUCTION_MIGRATION_DATABASE_URL"),
    caPath: requiredEnvironment("PGSSLROOTCERT"),
    planPath,
    evidencePath: requiredEnvironment("RELEASE_EVIDENCE_PATH"),
    ledgerDirectory: requiredEnvironment("RELEASE_LEDGER_DIRECTORY"),
    statePath: requiredEnvironment("RELEASE_STATE_PATH"),
    actor: requiredEnvironment("GITHUB_ACTOR"),
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    runAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
    candidateSha: requiredEnvironment("CANDIDATE_SHA"),
    executionSha: requiredEnvironment("EXECUTION_SHA"),
    pendingInput: requiredEnvironment("PENDING_INPUT"),
  });
  if (mode === "preflight") {
    await prepareNormalMigrationRelease(ports, releaseInput);
    console.log(JSON.stringify({ event: "production_migration_plan_persisted" }));
    return;
  }
  const { plan } = parsePersistedPlan(await readFile(planPath, "utf8"), releaseInput.pendingInput);
  const mutation = await completePreparedNormalMigrationRelease(ports, releaseInput, plan);
  console.log(JSON.stringify({ event: "production_migration_mutation_succeeded", applyOutcome: mutation.applyOutcome }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: "production_migration_runner_failed",
      detail: error instanceof ProductionMigrationReleaseError ? error.safeDetail : "inspect protected runner diagnostics",
    }));
    process.exitCode = 1;
  });
}

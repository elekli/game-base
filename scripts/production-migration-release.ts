import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { ProductionMigrationError } from "./production-migration-preflight";

type PendingMigration = Readonly<{
  version: string;
  name: string;
  filename: string;
  sha256: string;
}>;

export class ProductionMigrationReleaseError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionMigrationReleaseError: ${safeDetail}`);
    this.name = "ProductionMigrationReleaseError";
  }
}

export function buildReleaseIdentity(runId: string, runAttempt: number, candidateSha: string, pendingSetHash: string): string {
  fail(/^\d+$/.test(runId) && Number.isSafeInteger(runAttempt) && runAttempt > 0, "release run identity is invalid");
  fail(/^[a-f0-9]{40}$/.test(candidateSha) && /^[a-f0-9]{64}$/.test(pendingSetHash), "release content identity is invalid");
  return `${runId}-${runAttempt}-${candidateSha}-${pendingSetHash}`;
}

function fail(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new ProductionMigrationReleaseError(detail);
}

export function parsePendingMigrationInput(input: string) {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new ProductionMigrationReleaseError("pending migrations must be canonical JSON");
  }
  fail(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (filename) =>
          typeof filename === "string" && /^\d+_[a-z0-9_]+\.sql$/.test(filename),
      ) &&
      new Set(value).size === value.length &&
      [...value].sort().every((filename, index) => filename === value[index]) &&
      JSON.stringify(value) === input,
    "pending migrations must be a non-empty ordered canonical JSON filename array",
  );
  return value as string[];
}

export function assertPendingMigrationPlan(
  input: string,
  plan: { pendingMigrations?: unknown; pendingSetSha256?: unknown },
) {
  const filenames = parsePendingMigrationInput(input);
  fail(Array.isArray(plan.pendingMigrations), "preflight omitted pending migrations");
  const migrations = plan.pendingMigrations as PendingMigration[];
  fail(
    migrations.every(
      (migration) =>
        /^\d+$/.test(migration.version) &&
        /^[a-z0-9_]+$/.test(migration.name) &&
        migration.filename === `${migration.version}_${migration.name}.sql` &&
        /^[a-f0-9]{64}$/.test(migration.sha256),
    ),
    "preflight returned an invalid pending migration identity",
  );
  fail(
    JSON.stringify(migrations.map((migration) => migration.filename)) ===
      JSON.stringify(filenames),
    "operator pending migration input does not match preflight",
  );
  const setHash = createHash("sha256")
    .update(JSON.stringify(migrations))
    .digest("hex");
  fail(plan.pendingSetSha256 === setHash, "preflight pending-set hash mismatch");
  return { migrations, pendingSetSha256: setHash };
}

export async function buildPendingMigrationPlan(root: string, input: string) {
  const filenames = parsePendingMigrationInput(input);
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const match = /^(\d+)_([a-z0-9_]+)\.sql$/.exec(filename)!;
      const sql = await readFile(path.join(root, "supabase", "migrations", filename));
      return {
        version: match[1]!,
        name: match[2]!,
        filename,
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  return {
    pendingMigrations: migrations,
    pendingSetSha256: createHash("sha256")
      .update(JSON.stringify(migrations))
      .digest("hex"),
  };
}

export type NormalMigrationReleasePorts = Readonly<{
  resolveMain: () => Promise<string>;
  preflight: () => Promise<{ pendingMigrations?: unknown; pendingSetSha256?: unknown }>;
  persistPlan: (plan: Readonly<{ migrations: PendingMigration[]; pendingSetSha256: string }>) => Promise<void>;
  apply: () => Promise<void>;
  strictVerify: () => Promise<void>;
  persistSuccess: (plan: Readonly<{ migrations: PendingMigration[]; pendingSetSha256: string }>) => Promise<void>;
}>;

type NormalMigrationReleaseInput = Readonly<{
  candidateSha: string;
  executionSha: string;
  pendingInput: string;
}>;

function assertNormalReleaseIdentity(input: NormalMigrationReleaseInput) {
  fail(/^[a-f0-9]{40}$/.test(input.candidateSha), "candidate must be a full lowercase SHA");
  fail(/^[a-f0-9]{40}$/.test(input.executionSha), "execution commit must be a full lowercase SHA");
  fail(input.candidateSha === input.executionSha, "apply candidate and execution commit must match");
}

export async function prepareNormalMigrationRelease(
  ports: Pick<NormalMigrationReleasePorts, "resolveMain" | "preflight" | "persistPlan">,
  input: NormalMigrationReleaseInput,
) {
  assertNormalReleaseIdentity(input);
  const initialMain = await ports.resolveMain();
  fail(initialMain === input.executionSha, "execution commit is not current main");
  const first = assertPendingMigrationPlan(input.pendingInput, await ports.preflight());
  await ports.persistPlan(first);
  return first;
}

export async function runNormalMigrationRelease(
  ports: NormalMigrationReleasePorts,
  input: NormalMigrationReleaseInput,
) {
  const persisted = await prepareNormalMigrationRelease(ports, input);

  const mutation = await completePreparedNormalMigrationRelease(ports, input, persisted);
  await ports.persistSuccess(mutation.plan);
  return mutation;
}

export async function completePreparedNormalMigrationRelease(
  ports: Pick<NormalMigrationReleasePorts, "resolveMain" | "preflight" | "apply" | "strictVerify">,
  input: NormalMigrationReleaseInput,
  persistedPlan: Readonly<{ migrations: PendingMigration[]; pendingSetSha256: string }>,
) {
  assertNormalReleaseIdentity(input);
  const finalPlan = assertPendingMigrationPlan(input.pendingInput, await ports.preflight());
  fail(JSON.stringify(finalPlan) === JSON.stringify(persistedPlan), "preflight plans changed between reads");

  const applyMain = await ports.resolveMain();
  fail(applyMain === input.executionSha, "main advanced before migration apply");

  let applyFailure: unknown;
  try {
    await ports.apply();
  } catch (error) {
    applyFailure = error;
  }

  let strictFailure: unknown;
  try {
    await ports.strictVerify();
  } catch (error) {
    strictFailure = error;
  }
  if (strictFailure) {
    if (applyFailure) throw new ProductionMigrationReleaseError("migration apply failed and strict diagnostic failed");
    if (strictFailure instanceof ProductionMigrationError) {
      throw strictFailure;
    }
    throw new ProductionMigrationReleaseError("strict post-apply verification failed");
  }
  return {
    plan: finalPlan,
    applyOutcome: applyFailure ? "verified-after-ambiguous-apply" as const : "applied-and-verified" as const,
  };
}

type SourceRun = Readonly<{
  id: string;
  runAttempt: number;
  repository: string;
  workflowPath: string;
  event: string;
  headSha: string;
}>;

type SourceJob = Readonly<{
  id: number;
  name: string;
  runAttempt: number;
  steps: ReadonlyArray<Readonly<{ name: string; conclusion: string }>>;
}>;

export type LedgerRecoveryPorts = Readonly<{
  resolveMain: () => Promise<string>;
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  loadSourceRun: (runId: string) => Promise<SourceRun>;
  loadSourceJobs: (runId: string, runAttempt: number) => Promise<ReadonlyArray<SourceJob>>;
  loadPlanArtifact: (runId: string, runAttempt: number) => Promise<Readonly<{ text: string; metadataDigest: string; downloadedArchiveDigest: string; runAttempt: number }>>;
  readMigrationAtSource: (commit: string, filename: string) => Promise<string | Uint8Array>;
  readMigrationAtExecution: (commit: string, filename: string) => Promise<string | Uint8Array>;
  recoveryStrictVerify: (input: Readonly<{ sourceSha: string; plan: ReturnType<typeof assertPendingMigrationPlan> }>) => Promise<void>;
  persistLedger: (input: Readonly<{ identity: string; sourceSha: string; plan: ReturnType<typeof assertPendingMigrationPlan> }>) => Promise<"created" | "same" | "different">;
}>;

export async function runLedgerRecovery(
  ports: LedgerRecoveryPorts,
  input: Readonly<{
    sourceRunId: string;
    sourceRunAttempt: number;
    pendingInput: string;
    repository: string;
    workflowPath: string;
    sourceSha: string;
    executionSha: string;
  }>,
) {
  fail(/^\d+$/.test(input.sourceRunId) && Number.isSafeInteger(input.sourceRunAttempt) && input.sourceRunAttempt > 0, "source run input is invalid");
  fail(/^[a-f0-9]{40}$/.test(input.executionSha), "execution commit must be a full lowercase SHA");
  const source = await ports.loadSourceRun(input.sourceRunId);
  fail(
    source.id === input.sourceRunId &&
      source.runAttempt === input.sourceRunAttempt &&
      source.repository === input.repository &&
      source.workflowPath === input.workflowPath &&
      source.event === "workflow_dispatch" &&
      source.headSha === input.sourceSha &&
      /^[a-f0-9]{40}$/.test(source.headSha),
    "source run identity is invalid",
  );
  const currentMain = await ports.resolveMain();
  fail(currentMain === input.executionSha, "execution commit is not current main");
  fail(await ports.isAncestor(source.headSha, input.executionSha), "source commit is not an ancestor of execution commit");

  const jobs = await ports.loadSourceJobs(source.id, source.runAttempt);
  const mutationJobs = jobs.filter((job) => job.name === "Apply migration and preserve commit-bound ledger" && job.runAttempt === source.runAttempt);
  fail(mutationJobs.length === 1, "source mutation job identity is invalid");
  const authorizationSteps = mutationJobs[0]!.steps.filter((step) => step.name === "Authorize exact migration attempt");
  fail(authorizationSteps.length === 1 && authorizationSteps[0]!.conclusion === "success", "source authorization step must be unique and successful");
  const applySteps = mutationJobs[0]!.steps.filter((step) => step.name === "Apply and strict-verify exact migration suffix");
  fail(
    applySteps.length === 1 && ["success", "failure", "cancelled"].includes(applySteps[0]!.conclusion),
    "source mutation step did not prove execution began",
  );

  const artifact = await ports.loadPlanArtifact(source.id, source.runAttempt);
  fail(artifact.runAttempt === source.runAttempt, "source plan artifact run attempt mismatch");
  fail(
    /^sha256:[a-f0-9]{64}$/.test(artifact.metadataDigest) &&
      artifact.metadataDigest === artifact.downloadedArchiveDigest,
    "source plan artifact digest mismatch",
  );
  let parsedPlan: { pendingMigrations?: unknown; pendingSetSha256?: unknown };
  try {
    parsedPlan = JSON.parse(artifact.text) as typeof parsedPlan;
  } catch {
    throw new ProductionMigrationReleaseError("source plan artifact is not valid JSON");
  }
  const plan = assertPendingMigrationPlan(input.pendingInput, parsedPlan);
  for (const migration of plan.migrations) {
    const bytes = await ports.readMigrationAtSource(source.headSha, migration.filename);
    fail(createHash("sha256").update(bytes).digest("hex") === migration.sha256, "source migration bytes do not match the plan");
    const executionBytes = await ports.readMigrationAtExecution(input.executionSha, migration.filename);
    fail(createHash("sha256").update(executionBytes).digest("hex") === migration.sha256, "source migration bytes changed at execution commit");
  }
  await ports.recoveryStrictVerify({ sourceSha: source.headSha, plan });
  fail(await ports.resolveMain() === input.executionSha, "main advanced during ledger recovery");

  const identity = buildReleaseIdentity(source.id, source.runAttempt, source.headSha, plan.pendingSetSha256);
  const ledger = await ports.persistLedger({ identity, sourceSha: source.headSha, plan });
  fail(ledger !== "different", "ledger identity already has different evidence");
  return { identity, sourceSha: source.headSha, plan };
}

export type LedgerPublicationPorts = Readonly<{
  readMainLedger: (path: string) => Promise<string | null>;
  readBranchLedger: (branch: string, path: string) => Promise<Readonly<{ branchExists: boolean; ledgerText: string | null }>>;
  listPullRequests: (branch: string) => Promise<ReadonlyArray<Readonly<{
    head: string;
    base: string;
    title: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
    mergedAt: string | null;
  }>>>;
  createBranch: (branch: string, path: string) => Promise<void>;
  createPullRequest: (branch: string) => Promise<void>;
}>;

export async function publishLedgerPullRequest(
  ports: LedgerPublicationPorts,
  input: Readonly<{ identity: string; ledgerPath: string; ledgerText: string }>,
) {
  fail(/^\d+-[1-9]\d*-[a-f0-9]{40}-[a-f0-9]{64}$/.test(input.identity), "ledger publication identity is invalid");
  fail(
    input.ledgerPath === `.github/production-migration-ledger/${input.identity}.json`,
    "ledger publication path is not canonical",
  );
  const branch = `release-ledger/${input.identity}`;
  const title = `chore: record production migration ${input.identity}`;
  const pullRequests = await ports.listPullRequests(branch);
  fail(pullRequests.length <= 1, "ledger identity has duplicate pull requests");
  const pullRequest = pullRequests[0];
  if (pullRequest) {
    fail(
      pullRequest.head === branch && pullRequest.base === "main" && pullRequest.title === title,
      "ledger pull request identity differs",
    );
    fail(!pullRequest.isDraft, "ledger pull request must not be a draft");
    if (pullRequest.state === "OPEN") {
      fail(pullRequest.mergedAt === null, "open ledger pull request has invalid merge evidence");
    } else {
      fail(
        (pullRequest.state === "MERGED" || pullRequest.state === "CLOSED") &&
          typeof pullRequest.mergedAt === "string" &&
          !Number.isNaN(Date.parse(pullRequest.mergedAt)),
        "ledger pull request was closed without merge",
      );
    }
  }
  if (pullRequest && pullRequest.state !== "OPEN") {
    const mainLedger = await ports.readMainLedger(input.ledgerPath);
    fail(mainLedger === input.ledgerText, "merged pull request is missing its main ledger");
    return "same" as const;
  }
  if (pullRequest) {
    const branchLedger = await ports.readBranchLedger(branch, input.ledgerPath);
    fail(branchLedger.branchExists && branchLedger.ledgerText === input.ledgerText, "ledger branch identity differs");
    return "same" as const;
  }
  const mainLedger = await ports.readMainLedger(input.ledgerPath);
  fail(mainLedger === null, "canonical pull request evidence is missing");
  const branchLedger = await ports.readBranchLedger(branch, input.ledgerPath);
  if (branchLedger.branchExists) {
    fail(branchLedger.ledgerText === input.ledgerText, "ledger branch identity differs");
    await ports.createPullRequest(branch);
    return "reopened" as const;
  }
  await ports.createBranch(branch, input.ledgerPath);
  await ports.createPullRequest(branch);
  return "created" as const;
}

export function buildReleaseRecords(input: {
  commit: string;
  actor: string;
  runId: string;
  runAttempt?: number;
  releaseIdentity?: string;
  result: "success";
  pendingMigrations: readonly PendingMigration[];
  pendingSetSha256: string;
  utcTime: string;
}) {
  fail(/^[a-f0-9]{40}$/.test(input.commit), "record commit must be a full lowercase SHA");
  fail(/^\d+$/.test(input.runId), "record run ID must be numeric");
  fail(/^[A-Za-z0-9_\[\]-]{1,100}$/.test(input.actor), "record actor is invalid");
  fail(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.utcTime) && !Number.isNaN(Date.parse(input.utcTime)), "record UTC time is invalid");
  fail(input.runAttempt === undefined || (Number.isSafeInteger(input.runAttempt) && input.runAttempt > 0), "record run attempt must be positive");
  fail(
    createHash("sha256")
      .update(JSON.stringify(input.pendingMigrations))
      .digest("hex") === input.pendingSetSha256,
    "record pending-set hash mismatch",
  );
  const sourceRunAttempt = input.runAttempt ?? 1;
  const expectedReleaseIdentity = buildReleaseIdentity(input.runId, sourceRunAttempt, input.commit, input.pendingSetSha256);
  fail(input.releaseIdentity === undefined || input.releaseIdentity === expectedReleaseIdentity, "record release identity is invalid");
  const releaseIdentity = input.releaseIdentity ?? expectedReleaseIdentity;
  const evidence = {
    schemaVersion: 1,
    repository: "elekli/game-base",
    workflow: ".github/workflows/production-release.yml",
    releaseIdentity,
    commit: input.commit,
    migrations: input.pendingMigrations,
    pendingSetSha256: input.pendingSetSha256,
    sourceReleaseRun: { id: input.runId, attempt: sourceRunAttempt },
    successBasis: "strict-exact-target",
    actor: input.actor,
    utcTime: input.utcTime,
    result: input.result,
    recoveryAction: {
      missingLedgerAfterSuccess: "ledger-recovery",
      incompatibleDatabase: "forward-fix",
      destructiveRollback: "never-reset",
    },
  };
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  const ledger = {
    ...evidence,
    evidenceSha256: createHash("sha256").update(evidenceText).digest("hex"),
  };
  return { evidenceText, ledgerText: `${JSON.stringify(ledger, null, 2)}\n` };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-pending") {
    const [input, planPath] = args;
    fail(input && planPath, "validate-pending requires input and plan path");
    const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
    console.log(JSON.stringify(assertPendingMigrationPlan(input, plan)));
    return;
  }
  if (command === "plan-from-input") {
    const [input, root, outputPath] = args;
    fail(input && root && outputPath, "plan-from-input requires input, root, and output path");
    const plan = await buildPendingMigrationPlan(root, input);
    await writeFile(outputPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    return;
  }
  throw new ProductionMigrationReleaseError("unknown release command");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

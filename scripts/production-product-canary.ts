import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import postgres from "postgres";
import {
  buildGetVercelDeploymentRequest,
  buildGetVercelProductionAliasRequest,
  parseVercelProductionAlias,
} from "./vercel-deployment-rest-adapter";
import { createVercelRestTransport } from "./vercel-rest-transport";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[a-f0-9]{40}$/;
const GENERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REGISTRY_ID = "adf265a4-6136-4b1e-88f6-51bfa01ed773";
const FIXTURE_GAME_IDS = [
  "21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d",
  "c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c",
] as const;

type SafeCheck = Readonly<{ name: string; status: "passed" | "failed" }>;
type Evidence = Readonly<{
  schemaVersion: 1;
  executionSha: string;
  generation: string;
  deploymentIdBefore: string;
  deploymentIdAfter: string | null;
  checks: readonly SafeCheck[];
  cleanup: Readonly<{
    gamesRemoved: number;
    notesRemoved: number;
    listsRemoved: number;
    relationsRemoved: number;
    residualGames: number;
    residualNotes: number;
    residualLists: number;
    residualRelations: number;
  }> | null;
  outcome: "passed" | "failed-cleanup-complete" | "manual-recovery-required";
}>;

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value || value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`ProductionProductCanaryPrerequisiteError: required environment ${name} is unavailable`);
  }
  return value;
}

function ownerSubjectFromVerifiedToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ProductionProductCanaryPrerequisiteError: owner session is invalid");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("ProductionProductCanaryPrerequisiteError: owner session is invalid");
  }
  if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).sub !== "string") {
    throw new Error("ProductionProductCanaryPrerequisiteError: owner session is invalid");
  }
  return (payload as { sub: string }).sub;
}

async function verifyOwnerPing(domain: string, jwt: string, executionSha: string) {
  const response = await fetch(`https://${domain}/api/private/ping`, {
    headers: { "Cf-Access-Token": jwt, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("ProductionProductCanaryOwnerSessionError: owner session preflight failed");
  const body = await response.json() as Record<string, unknown>;
  if (body.status !== "ready" || body.executionSha !== executionSha) {
    throw new Error("ProductionProductCanaryDeploymentMismatchError: owner route execution SHA is not the requested deployment");
  }
}

function readReleaseContract() {
  return readFile(path.resolve(".github/production-release-contract.json"), "utf8")
    .then((content) => JSON.parse(content) as Record<string, unknown>);
}

async function verifyCurrentAlias(input: Readonly<{
  domain: string;
  projectId: string;
  teamId: string;
  token: string;
  executionSha: string;
}>) {
  const transport = createVercelRestTransport({
    teamId: input.teamId,
    timeoutMs: 15_000,
    token: input.token,
  });
  const aliasRequest = buildGetVercelProductionAliasRequest({
    customDomain: input.domain,
    projectId: input.projectId,
  });
  const deploymentId = parseVercelProductionAlias(
    await transport.getJson(aliasRequest.path, aliasRequest.query),
    { customDomain: input.domain, projectId: input.projectId },
  );
  const deploymentRequest = buildGetVercelDeploymentRequest(deploymentId);
  const rawDeployment = await transport.getJson(deploymentRequest.path, deploymentRequest.query);
  if (!rawDeployment || typeof rawDeployment !== "object") {
    throw new Error("ProductionProductCanaryDeploymentMismatchError: current deployment response is malformed");
  }
  const deployment = rawDeployment as Record<string, unknown>;
  const metadata = deployment.meta && typeof deployment.meta === "object"
    ? deployment.meta as Record<string, unknown>
    : {};
  if (deployment.id !== deploymentId || metadata.releaseCommit !== input.executionSha) {
    throw new Error("ProductionProductCanaryDeploymentMismatchError: current alias does not point to the requested release SHA");
  }
  return deploymentId;
}

function createDatabase() {
  const caPath = requiredEnvironment("PGSSLROOTCERT");
  return readFile(caPath, "utf8").then((ca) => {
    if (!ca.startsWith("-----BEGIN CERTIFICATE-----") || !ca.trimEnd().endsWith("-----END CERTIFICATE-----")) {
      throw new Error("ProductionProductCanaryPrerequisiteError: database CA is invalid");
    }
    return postgres(requiredEnvironment("PRODUCTION_MIGRATION_DATABASE_URL"), {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 1,
      ssl: { ca, rejectUnauthorized: true },
      onnotice: () => {},
    });
  });
}

async function claim(database: postgres.Sql, generation: string, ownerId: string) {
  const rows = await database.unsafe(
    "select app_private.claim_production_product_canary($1::uuid, $2) as claimed",
    [generation, ownerId],
  );
  return rows[0]?.claimed === true;
}

async function requireInspect(database: postgres.Sql, generation: string) {
  const rows = await database.unsafe(
    "select phase, generation, command_id, deadline_at from app_private.production_product_canaries where id = $1::uuid",
    [REGISTRY_ID],
  );
  const row = rows[0];
  if (!row || row.generation !== generation) throw new Error("ProductionProductCanaryRecoveryError: canary registry identity changed");
  return {
    phase: String(row.phase),
    commandId: row.command_id === null ? null : String(row.command_id),
    deadlineAt: row.deadline_at === null ? null : new Date(String(row.deadline_at)),
  } as const;
}

async function cleanup(database: postgres.Sql, generation: string) {
  let state = await requireInspect(database, generation);
  const stopAt = Date.now() + 45_000;
  while (state.phase === "request_pending" && (!state.deadlineAt || state.deadlineAt.getTime() > Date.now())) {
    if (Date.now() >= stopAt) throw new Error("ProductionProductCanaryRecoveryError: request deadline did not settle");
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await requireInspect(database, generation);
  }
  try {
    const prepared = await database.unsafe(
      "select app_private.prepare_production_product_canary_cleanup($1::uuid) as prepared",
      [generation],
    );
    if (prepared[0]?.prepared !== true) throw new Error("ProductionProductCanaryRecoveryError: cleanup phase was not prepared");
  } catch (error) {
    const current = await requireInspect(database, generation);
    if (current.phase === "request_pending" && current.commandId) {
      if (!current.deadlineAt || current.deadlineAt.getTime() > Date.now()) throw error;
      const recovery = await database.unsafe(
        "select app_private.require_production_product_canary_recovery($1::uuid, $2::uuid) as marked",
        [generation, current.commandId],
      );
      if (recovery[0]?.marked !== true) throw error;
      await database.unsafe(
        "select app_private.prepare_production_product_canary_cleanup($1::uuid)",
        [generation],
      );
    } else if (current.phase !== "cleanup_pending") {
      throw error;
    }
  }
  const result = await database.unsafe(
    "select * from app_private.cleanup_production_product_canary($1::uuid)",
    [generation],
  );
  const removed = result[0];
  if (!removed) throw new Error("ProductionProductCanaryRecoveryError: cleanup returned no receipt");
  const residual = await database.unsafe(
    `select
      (select count(*) from app_private.games where id = any($1::uuid[]) and is_production_canary is true) as games,
      (select count(*) from app_private.notes where game_id = any($1::uuid[])) as notes,
      (select count(*) from app_private.lists where is_production_canary is true and production_canary_generation = $2::uuid) as lists,
      (select count(*) from app_private.game_relations where left_game_id = any($1::uuid[]) or right_game_id = any($1::uuid[])) as relations`,
    [FIXTURE_GAME_IDS, generation],
  );
  const remaining = residual[0]!;
  const cleanupResult = {
    gamesRemoved: Number(removed.games_removed),
    notesRemoved: Number(removed.notes_removed),
    listsRemoved: Number(removed.lists_removed),
    relationsRemoved: Number(removed.relations_removed),
    residualGames: Number(remaining.games),
    residualNotes: Number(remaining.notes),
    residualLists: Number(remaining.lists),
    residualRelations: Number(remaining.relations),
  } as const;
  if (cleanupResult.residualGames + cleanupResult.residualNotes + cleanupResult.residualLists + cleanupResult.residualRelations !== 0) {
    throw new Error("ProductionProductCanaryRecoveryError: fixed canary residue remains");
  }
  return cleanupResult;
}

async function persistEvidence(evidence: Evidence) {
  const evidencePath = process.env.PRODUCTION_CANARY_EVIDENCE_PATH;
  if (!evidencePath) return;
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function publishScreenshotAfterCleanup() {
  const sourcePath = process.env.PRODUCTION_CANARY_SCREENSHOT_PATH;
  const artifactPath = process.env.PRODUCTION_CANARY_SCREENSHOT_OUTPUT_PATH;
  if (!sourcePath || !artifactPath) return;
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await copyFile(sourcePath, artifactPath);
}

async function run() {
  const domain = requiredEnvironment("PRODUCTION_CUSTOM_DOMAIN");
  const ownerJwt = requiredEnvironment("PRODUCTION_SMOKE_OWNER_ACCESS_JWT");
  const executionSha = requiredEnvironment("PRODUCTION_CANARY_EXECUTION_SHA");
  const generation = requiredEnvironment("PRODUCTION_CANARY_GENERATION");
  if (!FULL_SHA.test(executionSha) || !GENERATION_ID.test(generation)) {
    throw new Error("ProductionProductCanaryPrerequisiteError: release identity is malformed");
  }
  await verifyOwnerPing(domain, ownerJwt, executionSha);
  const ownerId = ownerSubjectFromVerifiedToken(ownerJwt);
  const contract = await readReleaseContract();
  const projectId = requiredEnvironment("VERCEL_PROJECT_ID");
  const teamId = requiredEnvironment("VERCEL_ORG_ID");
  if (contract.productionCustomDomain !== domain || contract.vercelProjectId !== projectId || contract.vercelTeamId !== teamId) {
    throw new Error("ProductionProductCanaryPrerequisiteError: release contract binding does not match");
  }
  const aliasInput = {
    domain,
    projectId,
    teamId,
    token: requiredEnvironment("VERCEL_TOKEN"),
    executionSha,
  } as const;
  const deploymentIdBefore = await verifyCurrentAlias(aliasInput);
  const startingEvidence: Evidence = {
    schemaVersion: 1,
    executionSha,
    generation,
    deploymentIdBefore,
    deploymentIdAfter: null,
    checks: [
      { name: "owner-session-and-sha", status: "passed" },
      { name: "production-alias-before", status: "passed" },
    ],
    cleanup: null,
    outcome: "manual-recovery-required",
  };
  // Persist the recovery identity before claiming the registry. If evidence storage
  // is unavailable, no canary generation or product row has been created yet.
  await persistEvidence(startingEvidence);
  const database = await createDatabase();
  const checks: SafeCheck[] = [
    { name: "owner-session-and-sha", status: "passed" },
    { name: "production-alias-before", status: "passed" },
  ];
  let deploymentIdAfter: string | null = null;
  let cleanupResult: Evidence["cleanup"] = null;
  let outcome: Evidence["outcome"] = "manual-recovery-required";
  try {
    if (!await claim(database, generation, ownerId)) {
      throw new Error("ProductionProductCanaryClaimError: an active or unrecovered canary generation already exists");
    }
    checks.push({ name: "fixed-generation-claimed", status: "passed" });
    const outputDir = process.env.PRODUCTION_CANARY_OUTPUT_DIR ?? path.resolve("test-results/production-canary");
    const screenshotPath = process.env.PRODUCTION_CANARY_SCREENSHOT_PATH ?? path.join(outputDir, "production-canary-390.png");
    await mkdir(outputDir, { recursive: true });
    try {
      await execFileAsync("pnpm", ["exec", "playwright", "test", "--config", "playwright.production-canary.config.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PRODUCTION_CANARY_BASE_URL: `https://${domain}`,
          PRODUCTION_CANARY_GENERATION: generation,
          PRODUCTION_CANARY_EXECUTION_SHA: executionSha,
          PRODUCTION_CANARY_OUTPUT_DIR: outputDir,
          PRODUCTION_CANARY_SCREENSHOT_PATH: screenshotPath,
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180_000,
      });
      checks.push({ name: "owner-browser-390px-product-flows", status: "passed" });
    } catch {
      checks.push({ name: "owner-browser-390px-product-flows", status: "failed" });
      throw new Error("ProductionProductCanaryBrowserFailure: protected owner browser acceptance failed");
    }
    deploymentIdAfter = await verifyCurrentAlias(aliasInput);
    if (deploymentIdAfter !== deploymentIdBefore) {
      checks.push({ name: "production-alias-after", status: "failed" });
      throw new Error("ProductionProductCanaryDeploymentMismatchError: production alias changed during canary");
    }
    await verifyOwnerPing(domain, ownerJwt, executionSha);
    checks.push({ name: "production-alias-and-owner-sha-after", status: "passed" });
    cleanupResult = await cleanup(database, generation);
    checks.push({ name: "exact-cleanup-zero-residue", status: "passed" });
    await publishScreenshotAfterCleanup();
    outcome = "passed";
  } catch (error) {
    let aliasStillMatches = false;
    try {
      deploymentIdAfter = await verifyCurrentAlias(aliasInput);
      await verifyOwnerPing(domain, ownerJwt, executionSha);
      aliasStillMatches = deploymentIdAfter === deploymentIdBefore;
    } catch {
      aliasStillMatches = false;
    }
    if (cleanupResult) {
      outcome = "failed-cleanup-complete";
    } else if (aliasStillMatches) {
      try {
        cleanupResult = await cleanup(database, generation);
        outcome = "failed-cleanup-complete";
      } catch {
      outcome = "manual-recovery-required";
    }
    if (cleanupResult) {
      try { await publishScreenshotAfterCleanup(); } catch { /* evidence keeps the completed cleanup outcome */ }
    }
    }
    const evidence: Evidence = {
      schemaVersion: 1,
      executionSha,
      generation,
      deploymentIdBefore,
      deploymentIdAfter,
      checks,
      cleanup: cleanupResult,
      outcome,
    };
    try { await persistEvidence(evidence); } catch { /* original canary failure remains primary */ }
    if (outcome !== "failed-cleanup-complete") process.stderr.write("production_product_canary_recovery_required\n");
    throw new Error(error instanceof Error ? error.message : "ProductionProductCanaryError: unknown failure");
  } finally {
    await database.end({ timeout: 5 });
  }
  const evidence: Evidence = {
    schemaVersion: 1,
    executionSha,
    generation,
    deploymentIdBefore,
    deploymentIdAfter,
    checks,
    cleanup: cleanupResult,
    outcome,
  };
  await persistEvidence(evidence);
  process.stdout.write(`${JSON.stringify({ event: "production_product_canary_passed", executionSha, generation, outcome })}\n`);
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "ProductionProductCanaryError: unknown failure"}\n`);
  process.exitCode = 1;
}

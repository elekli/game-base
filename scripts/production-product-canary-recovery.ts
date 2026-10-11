import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import {
  buildGetVercelDeploymentRequest,
  buildGetVercelProductionAliasRequest,
  parseVercelProductionAlias,
} from "./vercel-deployment-rest-adapter";
import { createVercelRestTransport } from "./vercel-rest-transport";

const REGISTRY_ID = "adf265a4-6136-4b1e-88f6-51bfa01ed773";
const GAME_IDS = ["21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d", "c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c"];
const FULL_SHA = /^[a-f0-9]{40}$/;
const GENERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const evidencePath = process.env.PRODUCTION_CANARY_RECOVERY_EVIDENCE_PATH;
const sourceExecutionSha = process.env.PRODUCTION_CANARY_SOURCE_EXECUTION_SHA ?? "";
const sourceGeneration = process.env.PRODUCTION_CANARY_SOURCE_GENERATION ?? "";

type RecoveryEvidence = {
  schemaVersion: 1;
  sourceExecutionSha: string | null;
  sourceGeneration: string | null;
  deploymentId: string | null;
  cleanup: Readonly<{ gamesRemoved: number; notesRemoved: number; listsRemoved: number; relationsRemoved: number; residual: Readonly<Record<string, number>> }> | null;
  outcome: "recovered" | "manual-recovery-required";
  failureCode?: "source-evidence-mismatch" | "production-alias-changed" | "request-not-expired" | "recovery-did-not-complete";
};

const evidence: RecoveryEvidence = {
  schemaVersion: 1,
  sourceExecutionSha: FULL_SHA.test(sourceExecutionSha) ? sourceExecutionSha : null,
  sourceGeneration: GENERATION_ID.test(sourceGeneration) ? sourceGeneration : null,
  deploymentId: null,
  cleanup: null,
  outcome: "manual-recovery-required",
  failureCode: "recovery-did-not-complete",
};
let database: postgres.Sql | undefined;

function required(name: string) {
  const value = process.env[name];
  if (!value || value !== value.trim() || /[\r\n]/.test(value)) throw new Error("CANARY_RECOVERY_PREREQUISITE");
  return value;
}

async function persistEvidence() {
  if (!evidencePath) return;
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function recover() {
  if (!FULL_SHA.test(sourceExecutionSha) || !GENERATION_ID.test(sourceGeneration)) {
    evidence.failureCode = "source-evidence-mismatch";
    throw new Error("CANARY_RECOVERY_SOURCE_IDENTITY");
  }
  const sourceEvidencePath = required("PRODUCTION_CANARY_SOURCE_EVIDENCE_PATH");
  const source = JSON.parse(await readFile(sourceEvidencePath, "utf8")) as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.executionSha !== sourceExecutionSha || source.generation !== sourceGeneration ||
      source.outcome !== "manual-recovery-required" || typeof source.deploymentIdBefore !== "string") {
    evidence.failureCode = "source-evidence-mismatch";
    throw new Error("CANARY_RECOVERY_SOURCE_EVIDENCE");
  }

  const domain = required("PRODUCTION_CUSTOM_DOMAIN");
  const projectId = required("VERCEL_PROJECT_ID");
  const teamId = required("VERCEL_ORG_ID");
  const contract = JSON.parse(await readFile(path.resolve(".github/production-release-contract.json"), "utf8")) as Record<string, unknown>;
  if (contract.productionCustomDomain !== domain || contract.vercelProjectId !== projectId || contract.vercelTeamId !== teamId) {
    throw new Error("CANARY_RECOVERY_PRODUCTION_BINDING");
  }
  const transport = createVercelRestTransport({ teamId, timeoutMs: 15_000, token: required("VERCEL_TOKEN") });
  const alias = buildGetVercelProductionAliasRequest({ customDomain: domain, projectId });
  const deploymentId = parseVercelProductionAlias(await transport.getJson(alias.path, alias.query), { customDomain: domain, projectId });
  evidence.deploymentId = deploymentId;
  if (deploymentId !== source.deploymentIdBefore) {
    evidence.failureCode = "production-alias-changed";
    throw new Error("CANARY_RECOVERY_ALIAS_CHANGED");
  }
  const deploymentRequest = buildGetVercelDeploymentRequest(deploymentId);
  const deployment = await transport.getJson(deploymentRequest.path, deploymentRequest.query) as Record<string, unknown>;
  const metadata = deployment.meta && typeof deployment.meta === "object" ? deployment.meta as Record<string, unknown> : {};
  if (deployment.id !== deploymentId || metadata.releaseCommit !== sourceExecutionSha) {
    evidence.failureCode = "production-alias-changed";
    throw new Error("CANARY_RECOVERY_DEPLOYMENT_SHA_CHANGED");
  }

  const ca = await readFile(required("PGSSLROOTCERT"), "utf8");
  if (!ca.startsWith("-----BEGIN CERTIFICATE-----") || !ca.trimEnd().endsWith("-----END CERTIFICATE-----")) throw new Error("CANARY_RECOVERY_DATABASE_CA");
  database = postgres(required("PRODUCTION_MIGRATION_DATABASE_URL"), {
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 1, ssl: { ca, rejectUnauthorized: true }, onnotice: () => {},
  });
  const rows = await database.unsafe(
    "select phase, generation, command_id, deadline_at from app_private.production_product_canaries where id = $1::uuid",
    [REGISTRY_ID],
  );
  const row = rows[0];
  if (!row || row.generation !== sourceGeneration) throw new Error("CANARY_RECOVERY_REGISTRY_MISMATCH");
  if (row.phase === "request_pending" && row.command_id) {
    const recoveryRows = await database.unsafe(
      "select app_private.require_production_product_canary_recovery($1::uuid, $2::uuid) as marked",
      [sourceGeneration, row.command_id],
    );
    if (recoveryRows[0]?.marked !== true) {
      evidence.failureCode = "request-not-expired";
      throw new Error("CANARY_RECOVERY_REQUEST_NOT_EXPIRED");
    }
  } else if (!["active", "cleanup_pending", "recovery_required"].includes(String(row.phase))) {
    throw new Error("CANARY_RECOVERY_PHASE_MISMATCH");
  }
  const prepared = await database.unsafe("select app_private.prepare_production_product_canary_cleanup($1::uuid) as prepared", [sourceGeneration]);
  if (prepared[0]?.prepared !== true) throw new Error("CANARY_RECOVERY_CLEANUP_PREPARATION");
  const cleanupRows = await database.unsafe("select * from app_private.cleanup_production_product_canary($1::uuid)", [sourceGeneration]);
  if (!cleanupRows[0]) throw new Error("CANARY_RECOVERY_CLEANUP_RECEIPT");
  const residualRows = await database.unsafe(
    `select
      (select count(*) from app_private.games where id = any($1::uuid[]) and is_production_canary is true) as games,
      (select count(*) from app_private.notes where game_id = any($1::uuid[])) as notes,
      (select count(*) from app_private.lists where is_production_canary is true and production_canary_generation = $2::uuid) as lists,
      (select count(*) from app_private.game_relations where left_game_id = any($1::uuid[]) or right_game_id = any($1::uuid[])) as relations`,
    [GAME_IDS, sourceGeneration],
  );
  const residual = residualRows[0]!;
  const counts = { games: Number(residual.games), notes: Number(residual.notes), lists: Number(residual.lists), relations: Number(residual.relations) };
  if (Object.values(counts).some((count) => count !== 0)) throw new Error("CANARY_RECOVERY_RESIDUE_REMAINS");
  evidence.cleanup = {
    gamesRemoved: Number(cleanupRows[0].games_removed),
    notesRemoved: Number(cleanupRows[0].notes_removed),
    listsRemoved: Number(cleanupRows[0].lists_removed),
    relationsRemoved: Number(cleanupRows[0].relations_removed),
    residual: counts,
  };
  evidence.outcome = "recovered";
  delete evidence.failureCode;
}

try {
  await recover();
} catch {
  evidence.outcome = "manual-recovery-required";
  process.stderr.write("production_product_canary_manual_recovery_required\n");
  process.exitCode = 1;
} finally {
  if (database) await database.end({ timeout: 5 });
  await persistEvidence();
}

if (evidence.outcome === "recovered") {
  process.stdout.write(`${JSON.stringify({ event: "production_product_canary_recovered", generation: evidence.sourceGeneration, outcome: evidence.outcome })}\n`);
}

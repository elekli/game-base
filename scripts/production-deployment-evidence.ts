import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProductionDeploymentRelease } from "./production-deployment-release";
import { isProductionReleaseFailureDiagnostic, projectProductionReleaseFailureDiagnostic } from "./production-release-failure-diagnostics";

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN_ID = /^[0-9]+$/;
const MIGRATION_TAIL = /^[0-9]{4,}$/;

export class ProductionDeploymentEvidenceError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionDeploymentEvidenceError: ${safeDetail}`);
    this.name = "ProductionDeploymentEvidenceError";
  }
}

export type ProductionDeploymentEvidenceContext = Readonly<{
  repository: "elekli/game-base";
  workflowRunId: string;
  workflowRunAttempt: number;
  productionDomain: string;
  migrationTail: string;
  startedAt: string;
  completedAt: string;
}>;

function validDateTime(value: string) {
  return value.length <= 64 && !Number.isNaN(Date.parse(value));
}

export function buildProductionDeploymentEvidence(
  release: ProductionDeploymentRelease,
  context: ProductionDeploymentEvidenceContext,
) {
  if (
    !["recording-evidence", "manual-recovery-required"].includes(release.phase) ||
    !FULL_SHA.test(release.executionSha) ||
    !SHA256.test(release.sourceManifestSha256) ||
    !DEPLOYMENT_ID.test(release.baselineDeploymentId ?? "") ||
    !DEPLOYMENT_ID.test(release.stagedDeploymentId ?? "") ||
    context.repository !== "elekli/game-base" ||
    !RUN_ID.test(context.workflowRunId) ||
    !Number.isSafeInteger(context.workflowRunAttempt) ||
    context.workflowRunAttempt < 1 ||
    !DOMAIN.test(context.productionDomain) ||
    !MIGRATION_TAIL.test(context.migrationTail) ||
    !validDateTime(context.startedAt) ||
    !validDateTime(context.completedAt) ||
    Date.parse(context.completedAt) < Date.parse(context.startedAt)
  ) {
    throw new ProductionDeploymentEvidenceError("evidence context is invalid");
  }

  const common = {
    schemaVersion: 2 as const,
    repository: context.repository,
    workflowRunId: context.workflowRunId,
    workflowRunAttempt: context.workflowRunAttempt,
    executionSha: release.executionSha,
    releaseIdentity: `production:${release.executionSha}`,
    sourceManifestSha256: release.sourceManifestSha256,
    canaryContractVersion: 3 as const,
    releaseKind: release.releaseKind,
    migrationTail: context.migrationTail,
    baselineDeploymentId: release.baselineDeploymentId!,
    stagedDeploymentId: release.stagedDeploymentId!,
    productionDomain: context.productionDomain,
    startedAt: context.startedAt,
    completedAt: context.completedAt,
    promotionAttempts: release.promotionAttempts,
    rollbackAttempts: release.rollbackAttempts,
  };

  if (release.evidenceOutcome === "passed" && release.smokeEvidence) {
    return {
      ...common,
      outcome: "passed" as const,
      rollbackOutcome: "not-required" as const,
      smoke: {
        outcome: "passed" as const,
        generation: release.smokeEvidence.generation,
        requestIds: [...release.smokeEvidence.requestIds],
        counts: release.smokeEvidence.counts,
        checks: release.smokeEvidence.checks,
      },
    };
  }
  if (
    release.evidenceOutcome === "rolled-back" &&
    release.smokeFailureEvidence
  ) {
    return {
      ...common,
      outcome: "rolled-back" as const,
      rollbackOutcome: "baseline-restored" as const,
      smoke: {
        outcome: "failed" as const,
        generation: release.smokeFailureEvidence.generation,
        requestIds: [...release.smokeFailureEvidence.requestIds],
        counts: release.smokeFailureEvidence.counts,
        checks: release.smokeFailureEvidence.checks,
      },
    };
  }
  if (
    release.phase === "manual-recovery-required" &&
    (release.failure === "smoke-execution-crash" ||
      release.failure === "smoke-execution-timeout") &&
    isProductionReleaseFailureDiagnostic(release.failureDiagnostic) &&
    release.failureDiagnostic.failureCode === release.failure
  ) {
    return {
      ...common,
      outcome: "manual-recovery-required" as const,
      rollbackOutcome: "not-attempted" as const,
      smoke: {
        outcome: "interrupted" as const,
        generation: release.smokeGeneration,
        requestIds: [],
      },
      failure: projectProductionReleaseFailureDiagnostic(release.failureDiagnostic),
    };
  }
  throw new ProductionDeploymentEvidenceError(
    "terminal smoke evidence is incomplete",
  );
}

export async function writeProductionDeploymentEvidence(
  outputPath: string,
  evidence: ReturnType<typeof buildProductionDeploymentEvidence>,
) {
  if (!path.isAbsolute(outputPath)) {
    throw new ProductionDeploymentEvidenceError("evidence path is not absolute");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, outputPath);
}

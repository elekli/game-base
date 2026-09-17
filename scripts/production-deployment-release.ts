import {
  consumeProductionSmokeCanaryTerminal,
  createProductionSmokeCanary,
  transitionProductionSmokeCanary,
  type ProductionSmokeCanary,
  type ProductionSmokeCanaryAction,
  type ProductionSmokeCanaryEvidence,
  type ProductionSmokeCanaryEvent,
  type ProductionSmokeFailedCleanupEvidence,
} from "./production-smoke-canary";
import type { ProductionReleaseFailureDiagnostic } from "./production-release-failure-diagnostics";

export type ProductionReleaseKind = "code-only" | "migration-bearing";
export type ProductionSchemaGate =
  | "strict-current-schema"
  | "migration-strict-and-ledger-complete";

export type ProductionDeploymentFailure =
  | "baseline-deployment-invalid"
  | "baseline-inspection-failed"
  | "evidence-write-failed"
  | "promotion-attempts-exhausted"
  | "promotion-guard-check-failed"
  | "promotion-guard-rejected"
  | "promotion-state-inspection-failed"
  | "release-gate-rejected"
  | "release-gate-check-failed"
  | "rollback-attempts-exhausted"
  | "rollback-state-inspection-failed"
  | "smoke-cleanup-unverified"
  | "smoke-execution-crash"
  | "smoke-execution-timeout"
  | "smoke-failed-baseline-restored"
  | "staged-deployment-ensure-failed"
  | "staged-deployment-identity-mismatch"
  | "staged-deployment-invalid"
  | "staged-ready-wait-failed"
  | "unexpected-current-deployment-after-promotion"
  | "unexpected-current-deployment-after-rollback"
  | "unexpected-current-deployment-before-rollback"
  | "pre-rollback-inspection-failed";

export class ProductionDeploymentReleaseError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionDeploymentReleaseError: ${safeDetail}`);
    this.name = "ProductionDeploymentReleaseError";
  }
}

type InspectionPurpose =
  | "snapshot-baseline"
  | "verify-promotion"
  | "before-rollback"
  | "verify-rollback";

export type ProductionDeploymentAction =
  | Readonly<{ kind: "verify-release-gate"; timeoutMs: number }>
  | Readonly<{
      kind: "inspect-current-deployment";
      purpose: InspectionPurpose;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "ensure-staged-deployment";
      executionSha: string;
      releaseIdentity: string;
      sourceManifestSha256: string;
      metadata: Readonly<{
        releaseCommit: string;
        releaseIdentity: string;
        sourceManifestSha256: string;
      }>;
      prod: true;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "await-staged-ready";
      deploymentId: string;
      intervalMs: number;
      maxAttempts: number;
      sourceManifestSha256: string;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "recheck-promotion-guard";
      expectedCurrentDeploymentId: string;
      executionSha: string;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "promote-staged";
      deploymentId: string;
      attempt: number;
      maxAttempts: number;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "run-production-smoke";
      deploymentId: string;
      executionSha: string;
      canaryAction: ProductionSmokeCanaryAction;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "rollback-baseline";
      deploymentId: string;
      attempt: number;
      maxAttempts: number;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "record-sanitized-evidence";
      executionSha: string;
      outcome: "passed";
      releaseIdentity: string;
      sourceManifestSha256: string;
      smokeEvidence: ProductionSmokeCanaryEvidence;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "record-sanitized-evidence";
      executionSha: string;
      outcome: "rolled-back";
      releaseIdentity: string;
      sourceManifestSha256: string;
      smokeFailureEvidence: ProductionSmokeFailedCleanupEvidence;
      timeoutMs: number;
    }>
  | Readonly<{ kind: "stop" }>;

export type ProductionDeploymentPhase =
  | "awaiting-release-gate"
  | "snapshotting-baseline"
  | "deploying-staged"
  | "awaiting-staged-ready"
  | "rechecking-promotion-guard"
  | "promoting-staged"
  | "verifying-promotion"
  | "running-smoke"
  | "inspecting-before-rollback"
  | "rolling-back"
  | "verifying-rollback"
  | "recording-evidence"
  | "manual-recovery-required"
  | "succeeded"
  | "failed";

type ReleaseContext = Readonly<{
  executionSha: string;
  releaseKind: ProductionReleaseKind;
  smokeGeneration: string;
  sourceManifestSha256: string;
}>;

export type ProductionDeploymentRelease = ReleaseContext &
  Readonly<{
    phase: ProductionDeploymentPhase;
    next: ProductionDeploymentAction;
    baselineDeploymentId?: string;
    stagedDeploymentId?: string;
    promotionAttempts: number;
    rollbackAttempts: number;
    failure?: ProductionDeploymentFailure;
    failureDiagnostic?: ProductionReleaseFailureDiagnostic;
    evidenceOutcome?: "passed" | "rolled-back";
    requestIds?: ReadonlyArray<string>;
    smokeEvidence?: ProductionSmokeCanaryEvidence;
    smokeFailureEvidence?: ProductionSmokeFailedCleanupEvidence;
    smokeCanary?: ProductionSmokeCanary;
  }>;

export type ProductionDeploymentEvent =
  | Readonly<{
      kind: "release-gate-observed";
      executionSha: string;
      exactMainCi: boolean;
      schemaGate: ProductionSchemaGate;
    }>
  | Readonly<{ kind: "current-deployment-observed"; deploymentId: string }>
  | Readonly<{
      kind: "staged-deployment-resolved";
      commitSha: string;
      deploymentId: string;
      releaseIdentity: string;
      sourceManifestSha256: string;
      source: "created" | "reused";
    }>
  | Readonly<{
      kind: "staged-deployment-ready";
      deploymentId: string;
      commitSha: string;
      releaseIdentity: string;
      sourceManifestSha256: string;
    }>
  | Readonly<{
      kind: "promotion-guard-observed";
      currentDeploymentId: string;
      mainSha: string;
    }>
  | Readonly<{
      kind: "promotion-attempt-finished";
      outcome: "reported-success" | "ambiguous-failure";
    }>
  | Readonly<{
      kind: "smoke-canary-event";
      event: ProductionSmokeCanaryEvent;
    }>
  | Readonly<{
      kind: "smoke-run-interrupted";
      reason: "timeout" | "crash";
      diagnostic: ProductionReleaseFailureDiagnostic;
    }>
  | Readonly<{
      kind: "rollback-attempt-finished";
      outcome: "reported-success" | "ambiguous-failure";
    }>
  | Readonly<{ kind: "evidence-recorded" }>
  | Readonly<{ kind: "operation-failed" }>;

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function failed(
  release: ProductionDeploymentRelease,
  failure: ProductionDeploymentFailure,
): ProductionDeploymentRelease {
  return { ...release, phase: "failed", failure, next: { kind: "stop" } };
}

function manualRecovery(
  release: ProductionDeploymentRelease,
  failure:
    | "smoke-cleanup-unverified"
    | "smoke-execution-crash"
    | "smoke-execution-timeout",
  failureDiagnostic?: ProductionReleaseFailureDiagnostic,
): ProductionDeploymentRelease {
  return {
    ...release,
    phase: "manual-recovery-required",
    failure,
    ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
    next: { kind: "stop" },
  };
}

function runProductionSmoke(
  release: ProductionDeploymentRelease,
  smokeCanary: ProductionSmokeCanary,
): ProductionDeploymentAction {
  return {
    kind: "run-production-smoke",
    deploymentId: release.stagedDeploymentId!,
    executionSha: release.executionSha,
    canaryAction: smokeCanary.next,
    timeoutMs: 180_000,
  };
}

function startProductionSmoke(
  release: ProductionDeploymentRelease,
): ProductionDeploymentRelease {
  const smokeCanary = createProductionSmokeCanary({
    executionSha: release.executionSha,
    generation: release.smokeGeneration,
  });
  return {
    ...release,
    phase: "running-smoke",
    smokeCanary,
    next: runProductionSmoke(release, smokeCanary),
  };
}

function recordRolledBackEvidence(
  release: ProductionDeploymentRelease,
): ProductionDeploymentRelease {
  if (!release.smokeFailureEvidence) {
    return manualRecovery(release, "smoke-cleanup-unverified");
  }
  return {
    ...release,
    evidenceOutcome: "rolled-back",
    phase: "recording-evidence",
    next: {
      kind: "record-sanitized-evidence",
      executionSha: release.executionSha,
      outcome: "rolled-back",
      releaseIdentity: `production:${release.executionSha}`,
      sourceManifestSha256: release.sourceManifestSha256,
      smokeFailureEvidence: release.smokeFailureEvidence,
      timeoutMs: 30_000,
    },
  };
}

function inspectCurrent(purpose: InspectionPurpose): ProductionDeploymentAction {
  return { kind: "inspect-current-deployment", purpose, timeoutMs: 30_000 };
}

function prePromotionFailure(
  phase: ProductionDeploymentPhase,
): ProductionDeploymentFailure | undefined {
  switch (phase) {
    case "awaiting-release-gate":
      return "release-gate-check-failed";
    case "snapshotting-baseline":
      return "baseline-inspection-failed";
    case "deploying-staged":
      return "staged-deployment-ensure-failed";
    case "awaiting-staged-ready":
      return "staged-ready-wait-failed";
    case "rechecking-promotion-guard":
      return "promotion-guard-check-failed";
    default:
      return undefined;
  }
}

export function createProductionDeploymentRelease(
  context: ReleaseContext,
): ProductionDeploymentRelease {
  if (!FULL_SHA.test(context.executionSha)) {
    throw new ProductionDeploymentReleaseError("execution SHA is invalid");
  }
  if (!SHA256.test(context.sourceManifestSha256)) {
    throw new ProductionDeploymentReleaseError(
      "source manifest SHA-256 is invalid",
    );
  }
  if (!UUID_V4.test(context.smokeGeneration)) {
    throw new ProductionDeploymentReleaseError("smoke generation is invalid");
  }
  return {
    ...context,
    phase: "awaiting-release-gate",
    next: { kind: "verify-release-gate", timeoutMs: 60_000 },
    promotionAttempts: 0,
    rollbackAttempts: 0,
  };
}

export function transitionProductionDeploymentRelease(
  release: ProductionDeploymentRelease,
  event: ProductionDeploymentEvent,
): ProductionDeploymentRelease {
  const namedPrePromotionFailure = prePromotionFailure(release.phase);
  if (event.kind === "operation-failed" && namedPrePromotionFailure) {
    return failed(release, namedPrePromotionFailure);
  }
  if (event.kind === "operation-failed") {
    switch (release.phase) {
      case "promoting-staged":
        return {
          ...release,
          phase: "verifying-promotion",
          next: inspectCurrent("verify-promotion"),
        };
      case "verifying-promotion":
        return failed(release, "promotion-state-inspection-failed");
      case "running-smoke":
        return manualRecovery(release, "smoke-cleanup-unverified");
      case "inspecting-before-rollback":
        return failed(release, "pre-rollback-inspection-failed");
      case "rolling-back":
        return {
          ...release,
          phase: "verifying-rollback",
          next: inspectCurrent("verify-rollback"),
        };
      case "verifying-rollback":
        return failed(release, "rollback-state-inspection-failed");
      case "recording-evidence":
        return failed(release, "evidence-write-failed");
      default:
        break;
    }
  }
  switch (release.phase) {
    case "awaiting-release-gate": {
      if (event.kind !== "release-gate-observed") break;
      const requiredSchemaGate =
        release.releaseKind === "migration-bearing"
          ? "migration-strict-and-ledger-complete"
          : "strict-current-schema";
      if (
        event.executionSha !== release.executionSha ||
        !event.exactMainCi ||
        event.schemaGate !== requiredSchemaGate
      ) {
        return failed(release, "release-gate-rejected");
      }
      return {
        ...release,
        phase: "snapshotting-baseline",
        next: inspectCurrent("snapshot-baseline"),
      };
    }
    case "snapshotting-baseline": {
      if (event.kind !== "current-deployment-observed") break;
      if (!DEPLOYMENT_ID.test(event.deploymentId)) {
        return failed(release, "baseline-deployment-invalid");
      }
      return {
        ...release,
        baselineDeploymentId: event.deploymentId,
        phase: "deploying-staged",
        next: {
          kind: "ensure-staged-deployment",
          executionSha: release.executionSha,
          releaseIdentity: `production:${release.executionSha}`,
          sourceManifestSha256: release.sourceManifestSha256,
          metadata: {
            releaseCommit: release.executionSha,
            releaseIdentity: `production:${release.executionSha}`,
            sourceManifestSha256: release.sourceManifestSha256,
          },
          prod: true,
          timeoutMs: 300_000,
        },
      };
    }
    case "deploying-staged": {
      if (event.kind !== "staged-deployment-resolved") break;
      if (
        !DEPLOYMENT_ID.test(event.deploymentId) ||
        event.deploymentId === release.baselineDeploymentId ||
        event.commitSha !== release.executionSha ||
        event.releaseIdentity !== `production:${release.executionSha}` ||
        event.sourceManifestSha256 !== release.sourceManifestSha256
      ) {
        return failed(release, "staged-deployment-invalid");
      }
      return {
        ...release,
        stagedDeploymentId: event.deploymentId,
        phase: "awaiting-staged-ready",
        next: {
          kind: "await-staged-ready",
          deploymentId: event.deploymentId,
          intervalMs: 5_000,
          maxAttempts: 60,
          sourceManifestSha256: release.sourceManifestSha256,
          timeoutMs: 300_000,
        },
      };
    }
    case "awaiting-staged-ready": {
      if (event.kind !== "staged-deployment-ready") break;
      if (
        event.deploymentId !== release.stagedDeploymentId ||
        event.commitSha !== release.executionSha ||
        event.releaseIdentity !== `production:${release.executionSha}` ||
        event.sourceManifestSha256 !== release.sourceManifestSha256
      ) {
        return failed(release, "staged-deployment-identity-mismatch");
      }
      return {
        ...release,
        phase: "rechecking-promotion-guard",
        next: {
          kind: "recheck-promotion-guard",
          expectedCurrentDeploymentId: release.baselineDeploymentId!,
          executionSha: release.executionSha,
          timeoutMs: 30_000,
        },
      };
    }
    case "rechecking-promotion-guard": {
      if (event.kind !== "promotion-guard-observed") break;
      if (event.mainSha !== release.executionSha) {
        return failed(release, "promotion-guard-rejected");
      }
      if (event.currentDeploymentId === release.stagedDeploymentId) {
        return startProductionSmoke(release);
      }
      if (event.currentDeploymentId !== release.baselineDeploymentId) {
        return failed(release, "promotion-guard-rejected");
      }
      const attempt = release.promotionAttempts + 1;
      if (attempt > 2) {
        return failed(release, "promotion-attempts-exhausted");
      }
      return {
        ...release,
        phase: "promoting-staged",
        promotionAttempts: attempt,
        next: {
          kind: "promote-staged",
          deploymentId: release.stagedDeploymentId!,
          attempt,
          maxAttempts: 2,
          timeoutMs: 60_000,
        },
      };
    }
    case "promoting-staged": {
      if (event.kind !== "promotion-attempt-finished") break;
      return {
        ...release,
        phase: "verifying-promotion",
        next: inspectCurrent("verify-promotion"),
      };
    }
    case "verifying-promotion": {
      if (event.kind !== "current-deployment-observed") break;
      if (event.deploymentId === release.stagedDeploymentId) {
        return startProductionSmoke(release);
      }
      if (event.deploymentId === release.baselineDeploymentId) {
        if (release.promotionAttempts >= 2) {
          return failed(release, "promotion-attempts-exhausted");
        }
        return {
          ...release,
          phase: "rechecking-promotion-guard",
          next: {
            kind: "recheck-promotion-guard",
            expectedCurrentDeploymentId: release.baselineDeploymentId!,
            executionSha: release.executionSha,
            timeoutMs: 30_000,
          },
        };
      }
      return failed(release, "unexpected-current-deployment-after-promotion");
    }
    case "running-smoke": {
      if (event.kind === "smoke-run-interrupted") {
        return manualRecovery(
          release,
          event.reason === "timeout"
            ? "smoke-execution-timeout"
            : "smoke-execution-crash",
          event.diagnostic,
        );
      }
      if (event.kind === "smoke-canary-event") {
        if (!release.smokeCanary) {
          return manualRecovery(release, "smoke-cleanup-unverified");
        }
        let smokeCanary: ProductionSmokeCanary;
        try {
          smokeCanary = transitionProductionSmokeCanary(
            release.smokeCanary,
            event.event,
          );
        } catch {
          return manualRecovery(release, "smoke-cleanup-unverified");
        }
        const terminal = consumeProductionSmokeCanaryTerminal(smokeCanary);
        if (terminal?.outcome === "passed") {
          const evidence = terminal.evidence;
          return {
            ...release,
            requestIds: evidence.requestIds,
            smokeCanary,
            smokeEvidence: evidence,
            evidenceOutcome: "passed",
            phase: "recording-evidence",
            next: {
              kind: "record-sanitized-evidence",
              executionSha: release.executionSha,
              outcome: "passed",
              releaseIdentity: `production:${release.executionSha}`,
              sourceManifestSha256: release.sourceManifestSha256,
              smokeEvidence: evidence,
              timeoutMs: 30_000,
            },
          };
        }
        if (terminal?.outcome === "failed-cleanup-complete") {
          return {
            ...release,
            requestIds: terminal.evidence.requestIds,
            smokeCanary,
            smokeFailureEvidence: terminal.evidence,
            phase: "inspecting-before-rollback",
            next: inspectCurrent("before-rollback"),
          };
        }
        if (
          smokeCanary.phase === "manual-recovery-required" ||
          smokeCanary.next.kind === "stop"
        ) {
          return manualRecovery(release, "smoke-cleanup-unverified");
        }
        return {
          ...release,
          smokeCanary,
          next: runProductionSmoke(release, smokeCanary),
        };
      }
      break;
    }
    case "inspecting-before-rollback": {
      if (event.kind !== "current-deployment-observed") break;
      if (event.deploymentId !== release.stagedDeploymentId) {
        if (event.deploymentId === release.baselineDeploymentId) {
          return recordRolledBackEvidence(release);
        }
        return failed(release, "unexpected-current-deployment-before-rollback");
      }
      return {
        ...release,
        rollbackAttempts: 1,
        phase: "rolling-back",
        next: {
          kind: "rollback-baseline",
          deploymentId: release.baselineDeploymentId!,
          attempt: 1,
          maxAttempts: 2,
          timeoutMs: 60_000,
        },
      };
    }
    case "rolling-back": {
      if (event.kind !== "rollback-attempt-finished") break;
      return {
        ...release,
        phase: "verifying-rollback",
        next: inspectCurrent("verify-rollback"),
      };
    }
    case "verifying-rollback": {
      if (event.kind !== "current-deployment-observed") break;
      if (event.deploymentId === release.baselineDeploymentId) {
        return recordRolledBackEvidence(release);
      }
      if (event.deploymentId === release.stagedDeploymentId) {
        if (release.rollbackAttempts >= 2) {
          return failed(release, "rollback-attempts-exhausted");
        }
        const attempt = release.rollbackAttempts + 1;
        return {
          ...release,
          rollbackAttempts: attempt,
          phase: "rolling-back",
          next: {
            kind: "rollback-baseline",
            deploymentId: release.baselineDeploymentId!,
            attempt,
            maxAttempts: 2,
            timeoutMs: 60_000,
          },
        };
      }
      return failed(release, "unexpected-current-deployment-after-rollback");
    }
    case "recording-evidence": {
      if (event.kind !== "evidence-recorded") break;
      if (release.evidenceOutcome === "rolled-back") {
        return failed(release, "smoke-failed-baseline-restored");
      }
      return { ...release, phase: "succeeded", next: { kind: "stop" } };
    }
    case "succeeded":
    case "failed":
    case "manual-recovery-required":
      break;
  }
  throw new ProductionDeploymentReleaseError("event is invalid for phase");
}

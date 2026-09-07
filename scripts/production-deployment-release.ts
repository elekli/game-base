export type ProductionReleaseKind = "code-only" | "migration-bearing";
export type ProductionSchemaGate =
  | "strict-current-schema"
  | "migration-strict-and-ledger-complete";

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
      kind: "deploy-staged";
      executionSha: string;
      idempotencyKey: string;
      prod: true;
      skipDomain: true;
      timeoutMs: number;
    }>
  | Readonly<{
      kind: "await-staged-ready";
      deploymentId: string;
      intervalMs: number;
      maxAttempts: number;
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
      outcome: "passed" | "rolled-back";
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
  | "succeeded"
  | "failed";

type ReleaseContext = Readonly<{
  executionSha: string;
  releaseKind: ProductionReleaseKind;
}>;

export type ProductionDeploymentRelease = ReleaseContext &
  Readonly<{
    phase: ProductionDeploymentPhase;
    next: ProductionDeploymentAction;
    baselineDeploymentId?: string;
    stagedDeploymentId?: string;
    promotionAttempts: number;
    rollbackAttempts: number;
    failure?: string;
    evidenceOutcome?: "passed" | "rolled-back";
    requestIds?: ReadonlyArray<string>;
  }>;

export type ProductionDeploymentEvent =
  | Readonly<{
      kind: "release-gate-observed";
      executionSha: string;
      exactMainCi: boolean;
      schemaGate: ProductionSchemaGate;
    }>
  | Readonly<{ kind: "current-deployment-observed"; deploymentId: string }>
  | Readonly<{ kind: "staged-deployment-created"; deploymentId: string }>
  | Readonly<{
      kind: "staged-deployment-ready";
      deploymentId: string;
      commitSha: string;
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
  | Readonly<{ kind: "smoke-passed"; requestIds: ReadonlyArray<string> }>
  | Readonly<{ kind: "smoke-failed"; requestIds: ReadonlyArray<string> }>
  | Readonly<{
      kind: "rollback-attempt-finished";
      outcome: "reported-success" | "ambiguous-failure";
    }>
  | Readonly<{ kind: "evidence-recorded" }>
  | Readonly<{ kind: "operation-failed" }>;

const FULL_SHA = /^[a-f0-9]{40}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;

function failed(
  release: ProductionDeploymentRelease,
  failure: string,
): ProductionDeploymentRelease {
  return { ...release, phase: "failed", failure, next: { kind: "stop" } };
}

function inspectCurrent(purpose: InspectionPurpose): ProductionDeploymentAction {
  return { kind: "inspect-current-deployment", purpose, timeoutMs: 30_000 };
}

export function createProductionDeploymentRelease(
  context: ReleaseContext,
): ProductionDeploymentRelease {
  if (!FULL_SHA.test(context.executionSha)) {
    throw new Error("ProductionDeploymentReleaseError: execution SHA is invalid");
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
  if (
    event.kind === "operation-failed" &&
    [
      "awaiting-release-gate",
      "snapshotting-baseline",
      "deploying-staged",
      "awaiting-staged-ready",
      "rechecking-promotion-guard",
    ].includes(release.phase)
  ) {
    return failed(release, "operation-failed-before-promotion");
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
          kind: "deploy-staged",
          executionSha: release.executionSha,
          idempotencyKey: `production:${release.executionSha}`,
          prod: true,
          skipDomain: true,
          timeoutMs: 300_000,
        },
      };
    }
    case "deploying-staged": {
      if (event.kind !== "staged-deployment-created") break;
      if (
        !DEPLOYMENT_ID.test(event.deploymentId) ||
        event.deploymentId === release.baselineDeploymentId
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
          timeoutMs: 300_000,
        },
      };
    }
    case "awaiting-staged-ready": {
      if (event.kind !== "staged-deployment-ready") break;
      if (
        event.deploymentId !== release.stagedDeploymentId ||
        event.commitSha !== release.executionSha
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
      if (
        event.mainSha !== release.executionSha ||
        event.currentDeploymentId !== release.baselineDeploymentId
      ) {
        return failed(release, "promotion-guard-rejected");
      }
      return {
        ...release,
        phase: "promoting-staged",
        promotionAttempts: 1,
        next: {
          kind: "promote-staged",
          deploymentId: release.stagedDeploymentId!,
          attempt: 1,
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
        return {
          ...release,
          phase: "running-smoke",
          next: {
            kind: "run-production-smoke",
            deploymentId: release.stagedDeploymentId!,
            executionSha: release.executionSha,
            timeoutMs: 180_000,
          },
        };
      }
      if (event.deploymentId === release.baselineDeploymentId) {
        if (release.promotionAttempts >= 2) {
          return failed(release, "promotion-attempts-exhausted");
        }
        const attempt = release.promotionAttempts + 1;
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
      return failed(release, "unexpected-current-deployment-after-promotion");
    }
    case "running-smoke": {
      if (event.kind === "smoke-passed") {
        return {
          ...release,
          requestIds: event.requestIds,
          evidenceOutcome: "passed",
          phase: "recording-evidence",
          next: {
            kind: "record-sanitized-evidence",
            outcome: "passed",
            timeoutMs: 30_000,
          },
        };
      }
      if (event.kind === "smoke-failed") {
        return {
          ...release,
          requestIds: event.requestIds,
          phase: "inspecting-before-rollback",
          next: inspectCurrent("before-rollback"),
        };
      }
      break;
    }
    case "inspecting-before-rollback": {
      if (event.kind !== "current-deployment-observed") break;
      if (event.deploymentId !== release.stagedDeploymentId) {
        if (event.deploymentId === release.baselineDeploymentId) {
          return {
            ...release,
            evidenceOutcome: "rolled-back",
            phase: "recording-evidence",
            next: {
              kind: "record-sanitized-evidence",
              outcome: "rolled-back",
              timeoutMs: 30_000,
            },
          };
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
        return {
          ...release,
          evidenceOutcome: "rolled-back",
          phase: "recording-evidence",
          next: {
            kind: "record-sanitized-evidence",
            outcome: "rolled-back",
            timeoutMs: 30_000,
          },
        };
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
      break;
  }
  throw new Error("ProductionDeploymentReleaseError: event is invalid for phase");
}

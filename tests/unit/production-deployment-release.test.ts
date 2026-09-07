import { describe, expect, it } from "vitest";

import {
  calculateProductionSmokePayloadSha256,
  type ProductionSmokeCanaryEvent,
} from "../../scripts/production-smoke-canary";

import {
  createProductionDeploymentRelease,
  ProductionDeploymentReleaseError,
  transitionProductionDeploymentRelease,
} from "../../scripts/production-deployment-release";

const SHA = "a".repeat(40);
const MANIFEST_SHA256 = "b".repeat(64);
const SMOKE_REQUEST_ID = "00000000-0000-4000-8000-000000000001";

function smokeEvidence(executionSha = SHA) {
  return {
    namespace: "release-smoke-v1" as const,
    executionSha,
    identity: `release-smoke-v1:${executionSha}`,
    payloadSha256: calculateProductionSmokePayloadSha256(executionSha),
    counts: {
      baseline: { row: 0, object: 0 },
      mutation: { row: 1, object: 1 },
      cleanup: { row: 0, object: 0 },
    },
    checks: {
      "custom-domain-owner-access": "passed" as const,
      "direct-origin-denied": "passed" as const,
      "authenticated-library-read": "passed" as const,
      "runtime-database-read": "passed" as const,
      "private-storage-direct-denied": "passed" as const,
      "canary-row-round-trip": "passed" as const,
      "canary-object-round-trip": "passed" as const,
      "canary-cleanup-counts": "passed" as const,
    },
    requestIds: [SMOKE_REQUEST_ID],
  };
}

function failedCleanupEvidence() {
  return {
    outcome: "failed" as const,
    requestIds: [SMOKE_REQUEST_ID],
    counts: { cleanup: { row: 0, object: 0 } },
    checks: { "canary-cleanup-counts": "passed" as const },
  };
}

function reachPromotionAttempt() {
  let release = createProductionDeploymentRelease({
    executionSha: SHA,
    releaseKind: "migration-bearing",
    sourceManifestSha256: MANIFEST_SHA256,
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "release-gate-observed",
    executionSha: SHA,
    exactMainCi: true,
    schemaGate: "migration-strict-and-ledger-complete",
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "current-deployment-observed",
    deploymentId: "dpl_D0",
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "staged-deployment-resolved",
    deploymentId: "dpl_D1",
    commitSha: SHA,
    releaseIdentity: `production:${SHA}`,
    sourceManifestSha256: MANIFEST_SHA256,
    source: "created",
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "staged-deployment-ready",
    deploymentId: "dpl_D1",
    commitSha: SHA,
    releaseIdentity: `production:${SHA}`,
    sourceManifestSha256: MANIFEST_SHA256,
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "promotion-guard-observed",
    currentDeploymentId: "dpl_D0",
    mainSha: SHA,
  });
  return release;
}

function reachPromotionVerification() {
  return transitionProductionDeploymentRelease(reachPromotionAttempt(), {
    kind: "promotion-attempt-finished",
    outcome: "ambiguous-failure",
  });
}

function reachSmoke() {
  return transitionProductionDeploymentRelease(reachPromotionVerification(), {
    kind: "current-deployment-observed",
    deploymentId: "dpl_D1",
  });
}

function sendCanaryEvent(
  release: ReturnType<typeof reachSmoke>,
  event: ProductionSmokeCanaryEvent,
) {
  return transitionProductionDeploymentRelease(release, {
    kind: "smoke-canary-event",
    event,
  });
}

function failedSmokeWithVerifiedCleanup(release: ReturnType<typeof reachSmoke>) {
  let next = sendCanaryEvent(release, {
    kind: "counts-observed",
    purpose: "baseline",
    rowCount: 0,
    objectCount: 0,
  });
  next = sendCanaryEvent(next, {
    kind: "fixed-read-checks-observed",
    checks: {
      "custom-domain-owner-access": "passed",
      "direct-origin-denied": "passed",
      "authenticated-library-read": "passed",
      "runtime-database-read": "passed",
      "private-storage-direct-denied": "passed",
    },
    requestIds: [SMOKE_REQUEST_ID],
  });
  next = sendCanaryEvent(next, {
    kind: "operation-failed",
    safeDetail: "canary write outcome is ambiguous",
  });
  next = sendCanaryEvent(next, { kind: "cleanup-finished" });
  return sendCanaryEvent(next, {
    kind: "counts-observed",
    purpose: "cleanup",
    rowCount: 0,
    objectCount: 0,
  });
}

function completedSmoke(release: ReturnType<typeof reachSmoke>) {
  let next = sendCanaryEvent(release, {
    kind: "counts-observed",
    purpose: "baseline",
    rowCount: 0,
    objectCount: 0,
  });
  next = sendCanaryEvent(next, {
    kind: "fixed-read-checks-observed",
    checks: {
      "custom-domain-owner-access": "passed",
      "direct-origin-denied": "passed",
      "authenticated-library-read": "passed",
      "runtime-database-read": "passed",
      "private-storage-direct-denied": "passed",
    },
    requestIds: [SMOKE_REQUEST_ID],
  });
  next = sendCanaryEvent(next, { kind: "row-written" });
  next = sendCanaryEvent(next, { kind: "object-written" });
  next = sendCanaryEvent(next, {
    kind: "round-trip-observed",
    rowCount: 1,
    objectCount: 1,
    rowIdentity: `release-smoke-v1:${SHA}`,
    objectIdentity: `release-smoke-v1:${SHA}`,
    rowPayloadSha256: calculateProductionSmokePayloadSha256(SHA),
    objectPayloadSha256: calculateProductionSmokePayloadSha256(SHA),
    requestIds: [SMOKE_REQUEST_ID],
  });
  next = sendCanaryEvent(next, { kind: "cleanup-finished" });
  return sendCanaryEvent(next, {
    kind: "counts-observed",
    purpose: "cleanup",
    rowCount: 0,
    objectCount: 0,
  });
}

describe("production deployment release model", () => {
  it("requires the release-kind-specific schema gate before reading Production", () => {
    const migrationRelease = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "migration-bearing",
      sourceManifestSha256: MANIFEST_SHA256,
    });

    expect(migrationRelease.next).toEqual({
      kind: "verify-release-gate",
      timeoutMs: 60_000,
    });

    const rejected = transitionProductionDeploymentRelease(migrationRelease, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });

    expect(rejected.phase).toBe("failed");
    expect(rejected.next).toEqual({ kind: "stop" });

    const codeOnlyRelease = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    const accepted = transitionProductionDeploymentRelease(codeOnlyRelease, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });

    expect(accepted.phase).toBe("snapshotting-baseline");
    expect(accepted.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "snapshot-baseline",
      timeoutMs: 30_000,
    });
  });

  it("stages the exact commit before promotion and records evidence only after smoke passes", () => {
    let release = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "migration-bearing",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "migration-strict-and-ledger-complete",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });

    expect(release.next).toEqual({
      kind: "ensure-staged-deployment",
      executionSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      metadata: {
        releaseCommit: SHA,
        releaseIdentity: `production:${SHA}`,
        sourceManifestSha256: MANIFEST_SHA256,
      },
      prod: true,
      timeoutMs: 300_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "created",
    });
    expect(release.next).toEqual({
      kind: "await-staged-ready",
      deploymentId: "dpl_D1",
      intervalMs: 5_000,
      maxAttempts: 60,
      sourceManifestSha256: MANIFEST_SHA256,
      timeoutMs: 300_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
    });
    expect(release.next).toEqual({
      kind: "recheck-promotion-guard",
      expectedCurrentDeploymentId: "dpl_D0",
      executionSha: SHA,
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D0",
      mainSha: SHA,
    });
    expect(release.next).toMatchObject({
      kind: "promote-staged",
      deploymentId: "dpl_D1",
      attempt: 1,
      maxAttempts: 2,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-attempt-finished",
      outcome: "reported-success",
    });
    expect(release.next).toMatchObject({
      kind: "inspect-current-deployment",
      purpose: "verify-promotion",
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    expect(release.next).toEqual({
      kind: "run-production-smoke",
      deploymentId: "dpl_D1",
      executionSha: SHA,
      canaryAction: {
        kind: "inspect-canary-counts",
        purpose: "baseline",
        rowId: "7355773e-c3b5-4e5d-9f07-55ac0e22f384",
        objectPath: "release-smoke-v1/canary.json",
      },
      timeoutMs: 180_000,
    });

    release = completedSmoke(release);
    expect(release.next).toEqual({
      kind: "record-sanitized-evidence",
      executionSha: SHA,
      outcome: "passed",
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      smokeEvidence: smokeEvidence(),
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "evidence-recorded",
    });
    expect(release.phase).toBe("succeeded");
    expect(release.next).toEqual({ kind: "stop" });
  });

  it("rejects even a hand-built complete success evidence object", () => {
    expect(() =>
      transitionProductionDeploymentRelease(reachSmoke(), {
        kind: "smoke-passed",
        evidence: smokeEvidence(),
      } as never),
    ).toThrow(ProductionDeploymentReleaseError);
  });

  it("never rolls back after an unverified smoke interruption", () => {
    for (const event of [
      { kind: "operation-failed" },
      { kind: "smoke-run-interrupted", reason: "timeout" },
      { kind: "smoke-run-interrupted", reason: "crash" },
    ]) {
      const release = transitionProductionDeploymentRelease(
        reachSmoke(),
        event as never,
      );
      expect(release.phase).toBe("manual-recovery-required");
      expect(release.next).toEqual({ kind: "stop" });
      expect(release.evidenceOutcome).toBeUndefined();
    }
  });

  it("permits rollback only after the canary has proved cleanup completed", () => {
    const release = failedSmokeWithVerifiedCleanup(reachSmoke());

    expect(release.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "before-rollback",
      timeoutMs: 30_000,
    });
  });

  it("retries promotion only when inspection still finds D0, and stops after a bounded second attempt", () => {
    let release = reachPromotionVerification();
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });

    expect(release.next).toEqual({
      kind: "recheck-promotion-guard",
      expectedCurrentDeploymentId: "dpl_D0",
      executionSha: SHA,
      timeoutMs: 30_000,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D0",
      mainSha: SHA,
    });
    expect(release.next).toMatchObject({
      kind: "promote-staged",
      deploymentId: "dpl_D1",
      attempt: 2,
      maxAttempts: 2,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-attempt-finished",
      outcome: "ambiguous-failure",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("promotion-attempts-exhausted");
    expect(release.next).toEqual({ kind: "stop" });
  });

  it("stops when main advances before a second promotion attempt", () => {
    let release = reachPromotionVerification();
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D0",
      mainSha: "b".repeat(40),
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("promotion-guard-rejected");
    expect(release.promotionAttempts).toBe(1);
  });

  it("stops without rollback when another deployment becomes current", () => {
    const release = transitionProductionDeploymentRelease(
      reachPromotionVerification(),
      {
        kind: "current-deployment-observed",
        deploymentId: "dpl_D2",
      },
    );

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe(
      "unexpected-current-deployment-after-promotion",
    );
    expect(release.next).toEqual({ kind: "stop" });
  });

  it("rolls back only after smoke failure is followed by proof that D1 is still current", () => {
    let release = failedSmokeWithVerifiedCleanup(reachSmoke());
    expect(release.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "before-rollback",
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    expect(release.next).toEqual({
      kind: "rollback-baseline",
      deploymentId: "dpl_D0",
      attempt: 1,
      maxAttempts: 2,
      timeoutMs: 60_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "rollback-attempt-finished",
      outcome: "reported-success",
    });
    expect(release.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "verify-rollback",
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    expect(release.next).toEqual({
      kind: "record-sanitized-evidence",
      executionSha: SHA,
      outcome: "rolled-back",
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      smokeFailureEvidence: failedCleanupEvidence(),
      timeoutMs: 30_000,
    });
    expect(release.rollbackAttempts).toBe(1);

    release = transitionProductionDeploymentRelease(release, {
      kind: "evidence-recorded",
    });
    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("smoke-failed-baseline-restored");
  });

  it("records cleanup proof with zero rollback attempts when inspection already finds D0", () => {
    let release = failedSmokeWithVerifiedCleanup(reachSmoke());
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });

    expect(release.rollbackAttempts).toBe(0);
    expect(release.next).toEqual({
      kind: "record-sanitized-evidence",
      executionSha: SHA,
      outcome: "rolled-back",
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      smokeFailureEvidence: failedCleanupEvidence(),
      timeoutMs: 30_000,
    });
  });

  it("never rolls back when post-smoke inspection finds a deployment other than D1", () => {
    let release = failedSmokeWithVerifiedCleanup(reachSmoke());
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D2",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe(
      "unexpected-current-deployment-before-rollback",
    );
    expect(release.next).toEqual({ kind: "stop" });
  });

  it("bounds rollback retries when an ambiguous command leaves D1 current", () => {
    let release = failedSmokeWithVerifiedCleanup(reachSmoke());
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "rollback-attempt-finished",
      outcome: "ambiguous-failure",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });

    expect(release.next).toMatchObject({
      kind: "rollback-baseline",
      attempt: 2,
      maxAttempts: 2,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "rollback-attempt-finished",
      outcome: "ambiguous-failure",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("rollback-attempts-exhausted");
  });

  it("stops pre-promotion failures with the baseline still active", () => {
    let release = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "created",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "operation-failed",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("staged-ready-wait-failed");
    expect(release.baselineDeploymentId).toBe("dpl_D0");
    expect(release.next).toEqual({ kind: "stop" });
  });

  it("requires manual recovery for a smoke command failure without cleanup proof", () => {
    const promotionFailure = transitionProductionDeploymentRelease(
      reachPromotionAttempt(),
      { kind: "operation-failed" },
    );
    expect(promotionFailure.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "verify-promotion",
      timeoutMs: 30_000,
    });

    const smokeFailure = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "operation-failed",
    });
    expect(smokeFailure.phase).toBe("manual-recovery-required");
    expect(smokeFailure.failure).toBe("smoke-cleanup-unverified");
    expect(smokeFailure.next).toEqual({ kind: "stop" });

    const inspectionFailure = transitionProductionDeploymentRelease(
      reachPromotionVerification(),
      { kind: "operation-failed" },
    );
    expect(inspectionFailure.failure).toBe(
      "promotion-state-inspection-failed",
    );
    expect(inspectionFailure.next).toEqual({ kind: "stop" });
  });

  it("names evidence persistence failure instead of reporting release success", () => {
    let release = completedSmoke(reachSmoke());
    release = transitionProductionDeploymentRelease(release, {
      kind: "operation-failed",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("evidence-write-failed");
  });

  it("fails visibly when rollback-state inspection cannot establish an authority", () => {
    let beforeRollback = failedSmokeWithVerifiedCleanup(reachSmoke());
    const beforeRollbackInspectionFailure =
      transitionProductionDeploymentRelease(beforeRollback, {
        kind: "operation-failed",
      });
    expect(beforeRollbackInspectionFailure.failure).toBe(
      "pre-rollback-inspection-failed",
    );

    beforeRollback = transitionProductionDeploymentRelease(beforeRollback, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    let rollbackFailure = transitionProductionDeploymentRelease(beforeRollback, {
      kind: "operation-failed",
    });
    expect(rollbackFailure.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "verify-rollback",
      timeoutMs: 30_000,
    });
    rollbackFailure = transitionProductionDeploymentRelease(rollbackFailure, {
      kind: "operation-failed",
    });
    expect(rollbackFailure.failure).toBe(
      "rollback-state-inspection-failed",
    );
  });

  it("reuses only a staged deployment resolved with the stable release identity", () => {
    let release = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "reused",
    });
    expect(release.next).toMatchObject({
      kind: "await-staged-ready",
      deploymentId: "dpl_D1",
    });

    let mismatched = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    mismatched = transitionProductionDeploymentRelease(mismatched, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    mismatched = transitionProductionDeploymentRelease(mismatched, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    mismatched = transitionProductionDeploymentRelease(mismatched, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${"b".repeat(40)}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "reused",
    });
    expect(mismatched.failure).toBe("staged-deployment-invalid");
  });

  it("rejects staged metadata or a changed main/D0 guard before promotion", () => {
    let metadataMismatch = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    metadataMismatch = transitionProductionDeploymentRelease(metadataMismatch, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    metadataMismatch = transitionProductionDeploymentRelease(metadataMismatch, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    metadataMismatch = transitionProductionDeploymentRelease(metadataMismatch, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "reused",
    });
    metadataMismatch = transitionProductionDeploymentRelease(metadataMismatch, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: "b".repeat(40),
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
    });
    expect(metadataMismatch.failure).toBe(
      "staged-deployment-identity-mismatch",
    );

    let guardChanged = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "migration-bearing",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "migration-strict-and-ledger-complete",
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "created",
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D2",
      mainSha: SHA,
    });
    expect(guardChanged.failure).toBe("promotion-guard-rejected");
  });

  it("carries the exact source manifest through create, reuse, READY, and evidence", () => {
    let release = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    expect(release.next).toMatchObject({
      kind: "ensure-staged-deployment",
      sourceManifestSha256: MANIFEST_SHA256,
      metadata: { sourceManifestSha256: MANIFEST_SHA256 },
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "reused",
    });
    expect(release.next).toMatchObject({
      kind: "await-staged-ready",
      sourceManifestSha256: MANIFEST_SHA256,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D0",
      mainSha: SHA,
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "promotion-attempt-finished",
      outcome: "reported-success",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    release = completedSmoke(release);
    expect(release.next).toEqual({
      kind: "record-sanitized-evidence",
      executionSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      outcome: "passed",
      smokeEvidence: smokeEvidence(),
      timeoutMs: 30_000,
    });

    let mismatch = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
      sourceManifestSha256: MANIFEST_SHA256,
    });
    mismatch = transitionProductionDeploymentRelease(mismatch, {
      kind: "release-gate-observed",
      executionSha: SHA,
      exactMainCi: true,
      schemaGate: "strict-current-schema",
    });
    mismatch = transitionProductionDeploymentRelease(mismatch, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D0",
    });
    mismatch = transitionProductionDeploymentRelease(mismatch, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST_SHA256,
      source: "created",
    });
    mismatch = transitionProductionDeploymentRelease(mismatch, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: "c".repeat(64),
    });
    expect(mismatch.failure).toBe("staged-deployment-identity-mismatch");
  });
});

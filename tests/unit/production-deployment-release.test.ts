import { describe, expect, it } from "vitest";

import {
  createProductionDeploymentRelease,
  transitionProductionDeploymentRelease,
} from "../../scripts/production-deployment-release";

const SHA = "a".repeat(40);

function reachPromotionAttempt() {
  let release = createProductionDeploymentRelease({
    executionSha: SHA,
    releaseKind: "migration-bearing",
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
    releaseIdentity: `production:${SHA}`,
    source: "created",
  });
  release = transitionProductionDeploymentRelease(release, {
    kind: "staged-deployment-ready",
    deploymentId: "dpl_D1",
    commitSha: SHA,
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

describe("production deployment release model", () => {
  it("requires the release-kind-specific schema gate before reading Production", () => {
    const migrationRelease = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "migration-bearing",
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
      metadata: {
        releaseCommit: SHA,
        releaseIdentity: `production:${SHA}`,
      },
      prod: true,
      skipDomain: true,
      timeoutMs: 300_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-resolved",
      deploymentId: "dpl_D1",
      releaseIdentity: `production:${SHA}`,
      source: "created",
    });
    expect(release.next).toEqual({
      kind: "await-staged-ready",
      deploymentId: "dpl_D1",
      intervalMs: 5_000,
      maxAttempts: 60,
      timeoutMs: 300_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
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
      timeoutMs: 180_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "smoke-passed",
      requestIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(release.next).toEqual({
      kind: "record-sanitized-evidence",
      outcome: "passed",
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "evidence-recorded",
    });
    expect(release.phase).toBe("succeeded");
    expect(release.next).toEqual({ kind: "stop" });
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
    let release = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "smoke-failed",
      requestIds: ["00000000-0000-4000-8000-000000000002"],
    });
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
      outcome: "rolled-back",
      timeoutMs: 30_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "evidence-recorded",
    });
    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("smoke-failed-baseline-restored");
  });

  it("never rolls back when post-smoke inspection finds a deployment other than D1", () => {
    let release = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "smoke-failed",
      requestIds: [],
    });
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
    let release = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "smoke-failed",
      requestIds: [],
    });
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
      releaseIdentity: `production:${SHA}`,
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

  it("treats command failures after promotion as ambiguous and re-inspects before mutating", () => {
    const promotionFailure = transitionProductionDeploymentRelease(
      reachPromotionAttempt(),
      { kind: "operation-failed" },
    );
    expect(promotionFailure.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "verify-promotion",
      timeoutMs: 30_000,
    });

    let smokeFailure = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "operation-failed",
    });
    expect(smokeFailure.next).toEqual({
      kind: "inspect-current-deployment",
      purpose: "before-rollback",
      timeoutMs: 30_000,
    });
    smokeFailure = transitionProductionDeploymentRelease(smokeFailure, {
      kind: "current-deployment-observed",
      deploymentId: "dpl_D1",
    });
    expect(smokeFailure.next.kind).toBe("rollback-baseline");

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
    let release = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "smoke-passed",
      requestIds: [],
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "operation-failed",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("evidence-write-failed");
  });

  it("fails visibly when rollback-state inspection cannot establish an authority", () => {
    let beforeRollback = transitionProductionDeploymentRelease(reachSmoke(), {
      kind: "smoke-failed",
      requestIds: [],
    });
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
      releaseIdentity: `production:${SHA}`,
      source: "reused",
    });
    expect(release.next).toMatchObject({
      kind: "await-staged-ready",
      deploymentId: "dpl_D1",
    });

    let mismatched = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
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
      releaseIdentity: `production:${"b".repeat(40)}`,
      source: "reused",
    });
    expect(mismatched.failure).toBe("staged-deployment-invalid");
  });

  it("rejects staged metadata or a changed main/D0 guard before promotion", () => {
    let metadataMismatch = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "code-only",
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
      releaseIdentity: `production:${SHA}`,
      source: "reused",
    });
    metadataMismatch = transitionProductionDeploymentRelease(metadataMismatch, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: "b".repeat(40),
    });
    expect(metadataMismatch.failure).toBe(
      "staged-deployment-identity-mismatch",
    );

    let guardChanged = createProductionDeploymentRelease({
      executionSha: SHA,
      releaseKind: "migration-bearing",
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
      releaseIdentity: `production:${SHA}`,
      source: "created",
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "staged-deployment-ready",
      deploymentId: "dpl_D1",
      commitSha: SHA,
    });
    guardChanged = transitionProductionDeploymentRelease(guardChanged, {
      kind: "promotion-guard-observed",
      currentDeploymentId: "dpl_D2",
      mainSha: SHA,
    });
    expect(guardChanged.failure).toBe("promotion-guard-rejected");
  });
});

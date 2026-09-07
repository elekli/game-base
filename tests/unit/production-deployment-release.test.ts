import { describe, expect, it } from "vitest";

import {
  createProductionDeploymentRelease,
  transitionProductionDeploymentRelease,
} from "../../scripts/production-deployment-release";

const SHA = "a".repeat(40);

function reachPromotionVerification() {
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
    kind: "staged-deployment-created",
    deploymentId: "dpl_D1",
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
  return transitionProductionDeploymentRelease(release, {
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
      kind: "deploy-staged",
      executionSha: SHA,
      idempotencyKey: `production:${SHA}`,
      prod: true,
      skipDomain: true,
      timeoutMs: 300_000,
    });

    release = transitionProductionDeploymentRelease(release, {
      kind: "staged-deployment-created",
      deploymentId: "dpl_D1",
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
      kind: "staged-deployment-created",
      deploymentId: "dpl_D1",
    });
    release = transitionProductionDeploymentRelease(release, {
      kind: "operation-failed",
    });

    expect(release.phase).toBe("failed");
    expect(release.failure).toBe("operation-failed-before-promotion");
    expect(release.baselineDeploymentId).toBe("dpl_D0");
    expect(release.next).toEqual({ kind: "stop" });
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
      kind: "staged-deployment-created",
      deploymentId: "dpl_D1",
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
      kind: "staged-deployment-created",
      deploymentId: "dpl_D1",
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

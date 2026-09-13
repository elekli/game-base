import { describe, expect, it } from "vitest";

import { buildProductionDeploymentEvidence } from "../../scripts/production-deployment-evidence";
import type { ProductionDeploymentRelease } from "../../scripts/production-deployment-release";

const SHA = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function release(): ProductionDeploymentRelease {
  return {
    executionSha: SHA,
    sourceManifestSha256: MANIFEST,
    releaseKind: "code-only",
    smokeGeneration: GENERATION,
    phase: "recording-evidence",
    next: {
      kind: "record-sanitized-evidence",
      executionSha: SHA,
      releaseIdentity: `production:${SHA}`,
      sourceManifestSha256: MANIFEST,
      outcome: "passed",
      smokeEvidence: {} as never,
      timeoutMs: 30_000,
    },
    baselineDeploymentId: "dpl_D0",
    stagedDeploymentId: "dpl_D1",
    promotionAttempts: 1,
    rollbackAttempts: 0,
    evidenceOutcome: "passed",
    smokeEvidence: {
      namespace: "release-smoke-v1",
      executionSha: SHA,
      generation: GENERATION,
      identity: `release-smoke-v1:${SHA}`,
      payloadSha256: "c".repeat(64),
      requestIds: [REQUEST_ID],
      counts: {
        baseline: { row: 0, object: 0 },
        mutation: { row: 1, object: 2 },
        cleanup: { row: 0, object: 0 },
      },
      checks: {
        "custom-domain-owner-access": "passed",
        "direct-origin-denied": "passed",
        "authenticated-library-read": "passed",
        "runtime-database-read": "passed",
        "private-storage-direct-denied": "passed",
        "canary-row-round-trip": "passed",
        "canary-object-round-trip": "passed",
        "private-media-original-read": "passed",
        "media-thumbnail-generated": "passed",
        "private-media-thumbnail-read": "passed",
        "canary-cleanup-counts": "passed",
      },
    },
  };
}

const context = {
  repository: "elekli/game-base" as const,
  workflowRunId: "123",
  workflowRunAttempt: 1,
  productionDomain: "games.example.com",
  migrationTail: "0015",
  startedAt: "2026-09-08T00:00:00.000Z",
  completedAt: "2026-09-08T00:01:00.000Z",
};

describe("production deployment evidence", () => {
  it("projects only the schema allowlist from a successful release", () => {
    expect(buildProductionDeploymentEvidence(release(), context)).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        outcome: "passed",
        rollbackOutcome: "not-required",
        smoke: expect.objectContaining({
          outcome: "passed",
          generation: GENERATION,
          requestIds: [REQUEST_ID],
        }),
      }),
    );
  });

  it("rejects non-terminal or malformed evidence context", () => {
    expect(() =>
      buildProductionDeploymentEvidence(
        { ...release(), phase: "succeeded" },
        context,
      ),
    ).toThrow("evidence context is invalid");
    expect(() =>
      buildProductionDeploymentEvidence(release(), {
        ...context,
        productionDomain: "https://games.example.com",
      }),
    ).toThrow("evidence context is invalid");
  });

  it("projects a manual smoke recovery without arbitrary error detail", () => {
    const evidence = buildProductionDeploymentEvidence(
      {
        ...release(),
        phase: "manual-recovery-required",
        next: { kind: "stop" },
        evidenceOutcome: undefined,
        smokeEvidence: undefined,
        promotionAttempts: 0,
        failure: "smoke-execution-crash",
        failureDiagnostic: {
          actionKind: "run-production-smoke",
          failureCode: "smoke-execution-crash",
          errorCode: "unknown-error",
        },
      },
      context,
    );

    expect(evidence).toMatchObject({
      outcome: "manual-recovery-required",
      rollbackOutcome: "not-attempted",
      promotionAttempts: 0,
      smoke: { outcome: "interrupted", generation: GENERATION, requestIds: [] },
      failure: {
        actionKind: "run-production-smoke",
        failureCode: "smoke-execution-crash",
        errorCode: "unknown-error",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("private smoke detail");
  });
  it("strips extra runtime diagnostic keys and rejects forged codes", () => {
    const diagnostic = { actionKind: "run-production-smoke", failureCode: "smoke-execution-crash", errorCode: "unknown-error", message: "SECRET_SENTINEL" };
    const interrupted = { ...release(), phase: "manual-recovery-required", next: { kind: "stop" }, evidenceOutcome: undefined, smokeEvidence: undefined, failure: "smoke-execution-crash", failureDiagnostic: diagnostic } as ProductionDeploymentRelease;
    expect(JSON.stringify(buildProductionDeploymentEvidence(interrupted, context))).not.toContain("SECRET_SENTINEL");
    diagnostic.errorCode = "SECRET_SENTINEL";
    expect(() => buildProductionDeploymentEvidence(interrupted, context)).toThrow("terminal smoke evidence is incomplete");
  });

});

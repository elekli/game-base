import { describe, expect, it, vi } from "vitest";

import {
  runProductionApplicationRelease,
  type ProductionApplicationReleaseRunnerPorts,
} from "../../scripts/production-application-release-runner";
import { calculateProductionSmokePayloadSha256 } from "../../scripts/production-smoke-canary";

const SHA = "a".repeat(40);
const MANIFEST_SHA256 = "b".repeat(64);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const IDENTITY = `release-smoke-v1:${SHA}`;
const PAYLOAD_SHA256 = calculateProductionSmokePayloadSha256(SHA);

function successfulPorts(): ProductionApplicationReleaseRunnerPorts {
  return {
    async execute(action) {
      switch (action.kind) {
        case "verify-release-gate":
          return {
            kind: "release-gate-observed",
            executionSha: SHA,
            exactMainCi: true,
            schemaGate: "strict-current-schema",
          };
        case "inspect-current-deployment":
          return {
            kind: "current-deployment-observed",
            deploymentId:
              action.purpose === "snapshot-baseline" ? "dpl_D0" : "dpl_D1",
          };
        case "ensure-staged-deployment":
          return {
            kind: "staged-deployment-resolved",
            commitSha: SHA,
            deploymentId: "dpl_D1",
            releaseIdentity: `production:${SHA}`,
            sourceManifestSha256: MANIFEST_SHA256,
            source: "created",
          };
        case "await-staged-ready":
          return {
            kind: "staged-deployment-ready",
            commitSha: SHA,
            deploymentId: "dpl_D1",
            releaseIdentity: `production:${SHA}`,
            sourceManifestSha256: MANIFEST_SHA256,
          };
        case "recheck-promotion-guard":
          return {
            kind: "promotion-guard-observed",
            currentDeploymentId: "dpl_D0",
            mainSha: SHA,
          };
        case "promote-staged":
          return {
            kind: "promotion-attempt-finished",
            outcome: "reported-success",
          };
        case "rollback-baseline":
          return {
            kind: "rollback-attempt-finished",
            outcome: "reported-success",
          };
        case "record-sanitized-evidence":
          return { kind: "evidence-recorded" };
        case "run-production-smoke": {
          const canaryAction = action.canaryAction;
          if (canaryAction.kind === "stop") {
            throw new Error("unexpected canary stop action");
          }
          const envelope = {
            generation: canaryAction.generation,
            actionSequence: canaryAction.actionSequence,
          };
          switch (canaryAction.kind) {
            case "inspect-canary-counts":
              return {
                kind: "smoke-canary-event",
                event: {
                  ...envelope,
                  kind: "counts-observed",
                  purpose: canaryAction.purpose,
                  rowCount: 0,
                  objectCount: 0,
                },
              };
            case "run-fixed-read-checks":
              return {
                kind: "smoke-canary-event",
                event: {
                  ...envelope,
                  kind: "fixed-read-checks-observed",
                  checks: {
                    "custom-domain-owner-access": "passed",
                    "direct-origin-denied": "passed",
                    "authenticated-library-read": "passed",
                    "runtime-database-read": "passed",
                  },
                  requestIds: [REQUEST_ID],
                },
              };
            case "write-canary-row":
              return {
                kind: "smoke-canary-event",
                event: { ...envelope, kind: "row-written" },
              };
            case "write-canary-object":
              return {
                kind: "smoke-canary-event",
                event: { ...envelope, kind: "object-written" },
              };
            case "verify-round-trip":
              return {
                kind: "smoke-canary-event",
                event: {
                  ...envelope,
                  kind: "round-trip-observed",
                  rowCount: 1,
                  objectCount: 2,
                  rowIdentity: IDENTITY,
                  objectIdentity: IDENTITY,
                  rowGeneration: GENERATION,
                  objectGeneration: GENERATION,
                  rowPhase: "object_written",
                  rowPayloadSha256: PAYLOAD_SHA256,
                  objectPayloadSha256: PAYLOAD_SHA256,
                  requestIds: [REQUEST_ID],
                },
              };
            case "verify-private-storage-denial":
              return {
                kind: "smoke-canary-event",
                event: {
                  ...envelope,
                  kind: "private-storage-denial-observed",
                  status: "passed",
                },
              };
            case "cleanup-exact-canary":
              return {
                kind: "smoke-canary-event",
                event: { ...envelope, kind: "cleanup-finished" },
              };
          }
        }
      }
    },
  };
}

describe("production application release runner", () => {
  it("drives the release model through exact staging, promotion, smoke, and evidence", async () => {
    const ports = successfulPorts();
    const execute = vi.spyOn(ports, "execute");

    await expect(
      runProductionApplicationRelease(
        {
          executionSha: SHA,
          releaseKind: "code-only",
          smokeGeneration: GENERATION,
          sourceManifestSha256: MANIFEST_SHA256,
        },
        ports,
      ),
    ).resolves.toMatchObject({
      phase: "succeeded",
      baselineDeploymentId: "dpl_D0",
      stagedDeploymentId: "dpl_D1",
      evidenceOutcome: "passed",
    });
    expect(execute).toHaveBeenCalledTimes(16);
  });

  it("turns a pre-promotion executor failure into a named terminal release", async () => {
    const ports = successfulPorts();
    const original = ports.execute;
    const failing: ProductionApplicationReleaseRunnerPorts = {
      execute: async (action, signal, release) => {
        if (action.kind === "ensure-staged-deployment") {
          throw new Error("private transport detail");
        }
        return original(action, signal, release);
      },
    };

    await expect(
      runProductionApplicationRelease(
        {
          executionSha: SHA,
          releaseKind: "code-only",
          smokeGeneration: GENERATION,
          sourceManifestSha256: MANIFEST_SHA256,
        },
        failing,
      ),
    ).resolves.toMatchObject({
      phase: "failed",
      failure: "staged-deployment-ensure-failed",
    });
  });

  it("requires manual recovery when smoke execution crashes", async () => {
    const ports = successfulPorts();
    const original = ports.execute;
    const crashing: ProductionApplicationReleaseRunnerPorts = {
      execute: async (action, signal, release) => {
        if (action.kind === "run-production-smoke") {
          throw new Error("private smoke detail");
        }
        return original(action, signal, release);
      },
    };

    await expect(
      runProductionApplicationRelease(
        {
          executionSha: SHA,
          releaseKind: "code-only",
          smokeGeneration: GENERATION,
          sourceManifestSha256: MANIFEST_SHA256,
        },
        crashing,
      ),
    ).resolves.toMatchObject({
      phase: "manual-recovery-required",
      failure: "smoke-execution-crash",
    });
  });

  it("cleans a failed private Storage check before restoring the baseline", async () => {
    const ports = successfulPorts();
    const original = ports.execute;
    const smokeActions: string[] = [];
    let rollbackFinished = false;
    const storageFailure: ProductionApplicationReleaseRunnerPorts = {
      execute: async (action, signal, release) => {
        if (action.kind === "run-production-smoke") {
          smokeActions.push(action.canaryAction.kind);
          if (action.canaryAction.kind === "verify-private-storage-denial") {
            return {
              kind: "smoke-canary-event",
              event: {
                kind: "operation-failed",
                safeDetail: "private Storage public path was not denied",
                generation: action.canaryAction.generation,
                actionSequence: action.canaryAction.actionSequence,
              },
            };
          }
        }
        if (action.kind === "rollback-baseline") rollbackFinished = true;
        if (
          action.kind === "inspect-current-deployment" &&
          action.purpose === "verify-rollback" &&
          rollbackFinished
        ) {
          return {
            kind: "current-deployment-observed",
            deploymentId: "dpl_D0",
          };
        }
        return original(action, signal, release);
      },
    };

    await expect(
      runProductionApplicationRelease(
        {
          executionSha: SHA,
          releaseKind: "code-only",
          smokeGeneration: GENERATION,
          sourceManifestSha256: MANIFEST_SHA256,
        },
        storageFailure,
      ),
    ).resolves.toMatchObject({
      phase: "failed",
      failure: "smoke-failed-baseline-restored",
      evidenceOutcome: "rolled-back",
      smokeFailureEvidence: {
        counts: { cleanup: { row: 0, object: 0 } },
      },
    });
    expect(smokeActions).toContain("cleanup-exact-canary");
    expect(smokeActions.at(-1)).toBe("inspect-canary-counts");
    expect(rollbackFinished).toBe(true);
  });
});

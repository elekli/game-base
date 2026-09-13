import {
  createProductionDeploymentRelease,
  transitionProductionDeploymentRelease,
  type ProductionDeploymentAction,
  type ProductionDeploymentEvent,
  type ProductionDeploymentRelease,
  type ProductionReleaseKind,
} from "./production-deployment-release";
import type {
  ProductionSmokeCanaryAction,
  ProductionSmokeCanaryEventPayload,
} from "./production-smoke-canary";
import { smokeInterruptionDiagnostic } from "./production-release-failure-diagnostics";
import type { VercelDeploymentRestAdapter } from "./vercel-deployment-rest-adapter";

const MAX_RELEASE_ACTIONS = 64;

export class ProductionApplicationReleaseRunnerError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionApplicationReleaseRunnerError: ${safeDetail}`);
    this.name = "ProductionApplicationReleaseRunnerError";
  }
}

export type ProductionApplicationReleaseRunnerPorts = Readonly<{
  execute(
    action: Exclude<ProductionDeploymentAction, Readonly<{ kind: "stop" }>>,
    signal: AbortSignal,
    release: ProductionDeploymentRelease,
  ): Promise<ProductionDeploymentEvent>;
}>;

export type ProductionApplicationReleaseActionDependencies = Readonly<{
  customDomain: string;
  executionSha: string;
  vercel: VercelDeploymentRestAdapter;
  verifyReleaseGate(): Promise<Readonly<{
    exactMainCi: boolean;
    schemaGate: "strict-current-schema" | "migration-strict-and-ledger-complete";
  }>>;
  resolveMain(): Promise<string>;
  runSmokeAction(
    action: ProductionSmokeCanaryAction,
    executionSha: string,
    deploymentOrigin: string,
    signal: AbortSignal,
  ): Promise<ProductionSmokeCanaryEventPayload>;
  recordEvidence(release: ProductionDeploymentRelease): Promise<void>;
}>;

export function createProductionApplicationReleaseRunnerPorts(
  dependencies: ProductionApplicationReleaseActionDependencies,
): ProductionApplicationReleaseRunnerPorts {
  let stagedDeploymentOrigin: string | undefined;
  return {
    async execute(action, signal, release) {
      if (signal.aborted) throw new ProductionApplicationReleaseRunnerError("release action aborted");
      switch (action.kind) {
        case "verify-release-gate": {
          const gate = await dependencies.verifyReleaseGate();
          return {
            kind: "release-gate-observed",
            executionSha: dependencies.executionSha,
            ...gate,
          };
        }
        case "inspect-current-deployment":
          return {
            kind: "current-deployment-observed",
            deploymentId: await dependencies.vercel.inspectCurrentDeployment(
              dependencies.customDomain,
              signal,
            ),
          };
        case "ensure-staged-deployment":
          return {
            kind: "staged-deployment-resolved",
            ...(await dependencies.vercel.ensureStagedDeployment(signal)),
          };
        case "await-staged-ready": {
          const ready = await dependencies.vercel.awaitStagedReady(action, signal);
          stagedDeploymentOrigin = `https://${ready.url}`;
          return { kind: "staged-deployment-ready", ...ready };
        }
        case "recheck-promotion-guard": {
          const [currentDeploymentId, mainSha] = await Promise.all([
            dependencies.vercel.inspectCurrentDeployment(
              dependencies.customDomain,
              signal,
            ),
            dependencies.resolveMain(),
          ]);
          return {
            kind: "promotion-guard-observed",
            currentDeploymentId,
            mainSha,
          };
        }
        case "promote-staged":
          await dependencies.vercel.promote(action.deploymentId, signal);
          return {
            kind: "promotion-attempt-finished",
            outcome: "reported-success",
          };
        case "run-production-smoke": {
          if (!stagedDeploymentOrigin) {
            throw new ProductionApplicationReleaseRunnerError(
              "staged deployment origin is unavailable",
            );
          }
          if (action.canaryAction.kind === "stop") {
            throw new ProductionApplicationReleaseRunnerError(
              "terminal smoke action cannot be executed",
            );
          }
          const event = await dependencies.runSmokeAction(
            action.canaryAction,
            action.executionSha,
            stagedDeploymentOrigin,
            signal,
          );
          return {
            kind: "smoke-canary-event",
            event: {
              ...event,
              generation: action.canaryAction.generation,
              actionSequence: action.canaryAction.actionSequence,
            },
          };
        }
        case "rollback-baseline":
          await dependencies.vercel.rollback(action.deploymentId, signal);
          return {
            kind: "rollback-attempt-finished",
            outcome: "reported-success",
          };
        case "record-sanitized-evidence":
          await dependencies.recordEvidence(release);
          return { kind: "evidence-recorded" };
      }
    },
  };
}

export async function runProductionApplicationRelease(
  input: Readonly<{
    executionSha: string;
    releaseKind: ProductionReleaseKind;
    smokeGeneration: string;
    sourceManifestSha256: string;
  }>,
  ports: ProductionApplicationReleaseRunnerPorts,
): Promise<ProductionDeploymentRelease> {
  let release = createProductionDeploymentRelease(input);
  for (let step = 0; step < MAX_RELEASE_ACTIONS; step += 1) {
    const action = release.next;
    if (action.kind === "stop") return release;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new ProductionApplicationReleaseRunnerError(
            "release action deadline exceeded",
          ),
        );
      }, action.timeoutMs);
    });
    let event: ProductionDeploymentEvent;
    try {
      event = await Promise.race([
        ports.execute(action, controller.signal, release),
        deadline,
      ]);
    } catch (error) {
      event =
        action.kind === "run-production-smoke"
          ? {
              kind: "smoke-run-interrupted",
              reason: timedOut ? "timeout" : "crash",
              diagnostic: smokeInterruptionDiagnostic(
                error,
                timedOut ? "smoke-execution-timeout" : "smoke-execution-crash",
              ),
            }
          : { kind: "operation-failed" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    release = transitionProductionDeploymentRelease(release, event);
  }
  throw new ProductionApplicationReleaseRunnerError(
    "release action bound exceeded",
  );
}

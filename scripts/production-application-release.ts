import { readFile } from "node:fs/promises";

import {
  createProductionDeploymentRelease,
  transitionProductionDeploymentRelease,
  type ProductionDeploymentRelease,
} from "./production-deployment-release";
import {
  buildProductionDeploymentSourceManifest,
  type ProductionDeploymentSourceManifestFile,
} from "./production-deployment-source-manifest";
import { createProductionSmokeRunner } from "./production-smoke-runner";
import { createVercelDeploymentRestAdapter } from "./vercel-deployment-rest-adapter";
import { createVercelMutationTransport } from "./vercel-rest-transport";
import type { VercelDeploymentRestAdapter } from "./vercel-deployment-rest-adapter";
import type { CanonicalProductionDeploymentSourceManifest } from "./production-deployment-source-manifest";
import type { ProductionSmokeRunner } from "./production-smoke-runner";

export type ProductionApplicationReleaseDriver = Readonly<{
  execute(action: ProductionDeploymentRelease["next"]): Promise<Parameters<typeof transitionProductionDeploymentRelease>[1]>;
}>;

/** 執行既有 bounded state machine；driver 只能回傳該動作對應 event，未知／拋錯一律 fail closed。 */
export async function driveProductionApplicationRelease(
  initial: ProductionDeploymentRelease,
  driver: ProductionApplicationReleaseDriver,
): Promise<ProductionDeploymentRelease> {
  let release = initial;
  for (let transitions = 0; transitions < 256 && release.next.kind !== "stop"; transitions += 1) {
    try {
      release = transitionProductionDeploymentRelease(release, await driver.execute(release.next));
    } catch {
      release = transitionProductionDeploymentRelease(release, { kind: "operation-failed" });
    }
  }
  if (release.next.kind !== "stop") throw new ProductionApplicationReleaseDisabledError();
  return release;
}

function deploymentId(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new Error("deployment response malformed");
  const id = (value as Record<string, unknown>).uid ?? (value as Record<string, unknown>).id;
  if (typeof id !== "string" || !/^dpl_[A-Za-z0-9]+$/.test(id)) throw new Error("deployment response malformed");
  return id;
}

export function createConcreteProductionApplicationReleaseDriver(input: Readonly<{
  adapter: VercelDeploymentRestAdapter;
  projectId: string;
  projectName: string;
  customDomain: string;
  manifest: CanonicalProductionDeploymentSourceManifest;
  readSourceFile(file: ProductionDeploymentSourceManifestFile): Promise<Uint8Array>;
  smoke: ProductionSmokeRunner;
  exactMainCi: boolean;
  schemaGate: "strict-current-schema" | "migration-strict-and-ledger-complete";
  mainSha(): Promise<string>;
  writeEvidence(action: Extract<ProductionDeploymentRelease["next"], { kind: "record-sanitized-evidence" }>): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}>): ProductionApplicationReleaseDriver {
  return { async execute(action) {
    switch (action.kind) {
      case "verify-release-gate": return { kind: "release-gate-observed", executionSha: action.kind && input.manifest.manifest.commitSha, exactMainCi: input.exactMainCi, schemaGate: input.schemaGate };
      case "inspect-current-deployment": return { kind: "current-deployment-observed", deploymentId: deploymentId(await input.adapter.getCurrentProductionDeployment(input.customDomain, input.projectId)) };
      case "ensure-staged-deployment": {
        const value = await input.adapter.ensureStagedDeployment({ projectName: input.projectName, projectId: input.projectId, commitSha: action.executionSha, releaseIdentity: action.releaseIdentity, sourceManifestArtifact: input.manifest, readFileBytes: input.readSourceFile });
        return { kind: "staged-deployment-resolved", commitSha: action.executionSha, deploymentId: value.deploymentId, releaseIdentity: action.releaseIdentity, sourceManifestSha256: action.sourceManifestSha256, source: value.source };
      }
      case "await-staged-ready": {
        for (let attempt = 0; attempt < action.maxAttempts; attempt += 1) { const value = await input.adapter.getDeployment(action.deploymentId); const state = typeof value === "object" && value !== null ? ((value as Record<string, unknown>).readyState ?? (value as Record<string, unknown>).state) : undefined; if (state === "READY") return { kind: "staged-deployment-ready", deploymentId: action.deploymentId, commitSha: input.manifest.manifest.commitSha, releaseIdentity: `production:${input.manifest.manifest.commitSha}`, sourceManifestSha256: action.sourceManifestSha256 }; await input.sleep(action.intervalMs); }
        return { kind: "operation-failed" };
      }
      case "recheck-promotion-guard": return { kind: "promotion-guard-observed", currentDeploymentId: deploymentId(await input.adapter.getCurrentProductionDeployment(input.customDomain, input.projectId)), mainSha: await input.mainSha() };
      case "promote-staged": await input.adapter.promote(action.deploymentId, input.projectId); return { kind: "promotion-attempt-finished", outcome: "reported-success" };
      case "rollback-baseline": await input.adapter.rollback(action.deploymentId, input.projectId); return { kind: "rollback-attempt-finished", outcome: "reported-success" };
      case "run-production-smoke": return { kind: "smoke-canary-event", event: await input.smoke.execute(action.canaryAction) };
      case "record-sanitized-evidence": await input.writeEvidence(action); return { kind: "evidence-recorded" };
      case "stop": throw new Error("terminal action");
    }
  } };
}

export class ProductionApplicationReleaseDisabledError extends Error {
  constructor() {
    super("Production application deployment remains fail-closed by the repository release contract.");
    this.name = "ProductionApplicationReleaseDisabledError";
  }
}

type ReleaseContract = Readonly<{
  productionDeploymentEnabled: boolean;
  productionSmokePrincipalStatus: "approved" | "unresolved";
  stagedProductionSafetyStatus: "verified" | "auto-assign-disablement-unverified";
}>;

/**
 * The live writer entrypoint. It deliberately reads the repository contract before
 * constructing a transport so an unapproved configuration cannot make a request.
 */
export async function runProductionApplicationRelease(root: string): Promise<never> {
  const contract = JSON.parse(await readFile(`${root}/.github/production-release-contract.json`, "utf8")) as ReleaseContract;
  if (
    contract.productionDeploymentEnabled !== true ||
    contract.productionSmokePrincipalStatus !== "approved" ||
    contract.stagedProductionSafetyStatus !== "verified"
  ) {
    throw new ProductionApplicationReleaseDisabledError();
  }
  // This branch is intentionally unreachable until the separately reviewed
  // contract changes. Keep the concrete wiring here so the sole writer stays
  // repository-owned rather than being recreated ad hoc in a workflow.
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const customDomain = process.env.PRODUCTION_CUSTOM_DOMAIN;
  const clientId = process.env.PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET;
  const executionSha = process.env.GITHUB_SHA;
  if (![token, teamId, projectId, customDomain, clientId, clientSecret, executionSha].every((value) => typeof value === "string" && value.trim() !== "")) {
    throw new ProductionApplicationReleaseDisabledError();
  }
  const manifest = await buildProductionDeploymentSourceManifest({ commitSha: executionSha!, repositoryRoot: root });
  const transport = createVercelMutationTransport({ token: token!, teamId: teamId!, timeoutMs: 30_000 });
  const adapter = createVercelDeploymentRestAdapter({ liveMutationsEnabled: true, stagedProductionSafetyVerified: true, transport });
  // TODO(#58-prerequisite): the internal route is intentionally not created until
  // a signed CF service principal and fixed app_private canary schema are approved.
  createProductionSmokeRunner({ principalStatus: contract.productionSmokePrincipalStatus, routeAndSchemaStatus: "unresolved", customDomain: customDomain!, cfAccessClientId: clientId!, cfAccessClientSecret: clientSecret! });
  void adapter;
  void manifest;
  throw new ProductionApplicationReleaseDisabledError();
}

if (process.argv[1]?.endsWith("production-application-release.ts")) {
  void runProductionApplicationRelease(process.cwd()).catch((error: unknown) => {
    const safe = error instanceof Error ? `${error.name}: ${error.message}` : "Production application release failed.";
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  });
}

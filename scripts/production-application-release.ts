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

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createProductionApplicationReleaseRunnerPorts,
  runProductionApplicationRelease,
} from "./production-application-release-runner";
import {
  buildProductionDeploymentEvidence,
  writeProductionDeploymentEvidence,
} from "./production-deployment-evidence";
import {
  buildProductionDeploymentSourceManifest,
  readProductionDeploymentSourceFileBytes,
} from "./production-deployment-source-manifest";
import { createProductionSmokeActionRunner } from "./production-smoke-runner";
import { createVercelDeploymentRestAdapter } from "./vercel-deployment-rest-adapter";
import { createVercelRestTransport } from "./vercel-rest-transport";

const FULL_SHA = /^[a-f0-9]{40}$/;
const MIGRATION_TAIL = /^[0-9]{4,}$/;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;

export class ProductionApplicationReleasePrerequisiteError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionApplicationReleasePrerequisiteError: ${safeDetail}`);
    this.name = "ProductionApplicationReleasePrerequisiteError";
  }
}

type ReleaseContract = Readonly<{
  repository?: unknown;
  productionBranch?: unknown;
  ciWorkflow?: unknown;
  vercelProjectId?: unknown;
  vercelProjectName?: unknown;
  vercelTeamId?: unknown;
  productionDeploymentEnabled?: unknown;
  productionDeploymentStatus?: unknown;
  stagedProductionSafetyStatus?: unknown;
  productionSmokePrincipalStatus?: unknown;
  productionCustomDomain?: unknown;
}>;

type EnabledReleaseContract = Readonly<{
  repository: "elekli/game-base";
  productionBranch: "main";
  ciWorkflow: ".github/workflows/ci.yml";
  vercelProjectId: string;
  vercelProjectName: string;
  vercelTeamId: string;
  productionDeploymentEnabled: true;
  productionDeploymentStatus: "ready-protected-rest-release";
  stagedProductionSafetyStatus: "verified-auto-assign-disabled";
  productionSmokePrincipalStatus: "verified";
  productionCustomDomain: string;
}>;

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value || value !== value.trim() || /[\r\n]/.test(value)) {
    throw new ProductionApplicationReleasePrerequisiteError(
      `required environment ${name} is unavailable`,
    );
  }
  return value;
}

async function readBoundedJson(response: Response) {
  if (!response.ok || !response.body) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "GitHub release-gate request failed",
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_GITHUB_RESPONSE_BYTES) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "GitHub release-gate response exceeded its bound",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_GITHUB_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new ProductionApplicationReleasePrerequisiteError(
        "GitHub release-gate response exceeded its bound",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ProductionApplicationReleasePrerequisiteError(
      "GitHub release-gate response was malformed",
    );
  }
}

function githubGet(pathname: string, token: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  return fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: controller.signal,
  })
    .then(readBoundedJson)
    .catch((error) => {
      if (error instanceof ProductionApplicationReleasePrerequisiteError) {
        throw error;
      }
      throw new ProductionApplicationReleasePrerequisiteError(
        "GitHub release-gate request failed",
      );
    })
    .finally(() => clearTimeout(timer));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveGitHubMain(repository: string, token: string) {
  const value = await githubGet(
    `/repos/${repository}/git/ref/heads/main`,
    token,
  );
  const sha =
    isRecord(value) && isRecord(value.object) ? value.object.sha : undefined;
  if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "GitHub main reference was malformed",
    );
  }
  return sha;
}

async function exactMainCiSucceeded(
  repository: string,
  executionSha: string,
  token: string,
) {
  const value = await githubGet(
    `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${executionSha}&branch=main&event=push&status=success&per_page=100`,
    token,
  );
  return (
    isRecord(value) &&
    Array.isArray(value.workflow_runs) &&
    value.workflow_runs.some(
      (run) =>
        isRecord(run) &&
        run.head_sha === executionSha &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.conclusion === "success",
    )
  );
}

async function readContract(
  repositoryRoot: string,
): Promise<EnabledReleaseContract> {
  const contract = JSON.parse(
    await readFile(
      path.join(repositoryRoot, ".github/production-release-contract.json"),
      "utf8",
    ),
  ) as ReleaseContract;
  if (
    contract.repository !== "elekli/game-base" ||
    contract.productionBranch !== "main" ||
    contract.ciWorkflow !== ".github/workflows/ci.yml" ||
    typeof contract.vercelProjectId !== "string" ||
    typeof contract.vercelProjectName !== "string" ||
    typeof contract.vercelTeamId !== "string" ||
    contract.productionDeploymentEnabled !== true ||
    contract.productionDeploymentStatus !== "ready-protected-rest-release" ||
    contract.stagedProductionSafetyStatus !== "verified-auto-assign-disabled" ||
    contract.productionSmokePrincipalStatus !== "verified" ||
    typeof contract.productionCustomDomain !== "string"
  ) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "repository production deployment contract is not enabled",
    );
  }
  return contract as EnabledReleaseContract;
}

export async function runProductionApplicationReleaseFromEnvironment(
  repositoryRoot = process.cwd(),
) {
  const executionSha = requiredEnvironment("EXECUTION_SHA");
  const releaseKind = requiredEnvironment("RELEASE_KIND");
  const migrationTail = requiredEnvironment("MIGRATION_TAIL");
  const workflowRunId = requiredEnvironment("GITHUB_RUN_ID");
  const workflowRunAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT"));
  const evidencePath = requiredEnvironment("RELEASE_EVIDENCE_PATH");
  const githubToken = requiredEnvironment("GITHUB_TOKEN");
  if (
    !FULL_SHA.test(executionSha) ||
    !["code-only", "migration-bearing"].includes(releaseKind) ||
    !MIGRATION_TAIL.test(migrationTail) ||
    !Number.isSafeInteger(workflowRunAttempt) ||
    workflowRunAttempt < 1
  ) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "release identity is invalid",
    );
  }
  const contract = await readContract(repositoryRoot);
  const customDomain = requiredEnvironment("PRODUCTION_CUSTOM_DOMAIN");
  if (
    customDomain !== contract.productionCustomDomain ||
    requiredEnvironment("VERCEL_PROJECT_ID") !== contract.vercelProjectId ||
    requiredEnvironment("VERCEL_ORG_ID") !== contract.vercelTeamId
  ) {
    throw new ProductionApplicationReleasePrerequisiteError(
      "hosted release bindings do not match the repository contract",
    );
  }

  const source = await buildProductionDeploymentSourceManifest({
    commitSha: executionSha,
    repositoryRoot,
  });
  const transport = createVercelRestTransport({
    token: requiredEnvironment("VERCEL_TOKEN"),
    teamId: contract.vercelTeamId,
    timeoutMs: 40_000,
  });
  const vercel = createVercelDeploymentRestAdapter({
    projectId: contract.vercelProjectId,
    projectName: contract.vercelProjectName,
    releaseIdentity: `production:${executionSha}`,
    sourceManifestArtifact: source,
    stagedProductionSafetyVerified: true,
    transport,
    loadSourceFile: (file) =>
      readProductionDeploymentSourceFileBytes({
        commitSha: executionSha,
        file,
        repositoryRoot,
      }),
  });
  const smokeConfig = {
    customDomain,
    supabaseUrl: requiredEnvironment("PRODUCTION_SMOKE_SUPABASE_URL"),
    publishableKey: requiredEnvironment(
      "PRODUCTION_SMOKE_SUPABASE_PUBLISHABLE_KEY",
    ),
    cfAccessClientId: requiredEnvironment(
      "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID",
    ),
    cfAccessClientSecret: requiredEnvironment(
      "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET",
    ),
    ownerAccessJwt: requiredEnvironment("PRODUCTION_SMOKE_OWNER_ACCESS_JWT"),
  };
  const startedAt = new Date().toISOString();
  const ports = createProductionApplicationReleaseRunnerPorts({
    executionSha,
    customDomain,
    vercel,
    async verifyReleaseGate() {
      const [mainSha, exactMainCi] = await Promise.all([
        resolveGitHubMain(contract.repository, githubToken),
        exactMainCiSucceeded(
          contract.repository,
          executionSha,
          githubToken,
        ),
      ]);
      return {
        exactMainCi: exactMainCi && mainSha === executionSha,
        schemaGate:
          releaseKind === "migration-bearing"
            ? "migration-strict-and-ledger-complete"
            : "strict-current-schema",
      };
    },
    resolveMain: () =>
      resolveGitHubMain(contract.repository, githubToken),
    runSmokeAction(action, sha, deploymentOrigin, signal) {
      return createProductionSmokeActionRunner({
        ...smokeConfig,
        deploymentOrigin,
      })(action, sha, signal);
    },
    recordEvidence: async (release) => {
      const evidence = buildProductionDeploymentEvidence(release, {
        repository: "elekli/game-base",
        workflowRunId,
        workflowRunAttempt,
        productionDomain: customDomain,
        migrationTail,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      await writeProductionDeploymentEvidence(evidencePath, evidence);
    },
  });
  const release = await runProductionApplicationRelease(
    {
      executionSha,
      releaseKind: releaseKind as "code-only" | "migration-bearing",
      smokeGeneration: randomUUID(),
      sourceManifestSha256: source.sourceManifestSha256,
    },
    ports,
  );
  if (release.phase !== "succeeded") {
    throw new ProductionApplicationReleasePrerequisiteError(
      `release stopped in ${release.phase}:${release.failure ?? "unknown"}`,
    );
  }
  console.log(
    JSON.stringify({
      event: "production_application_release_completed",
      executionSha,
      outcome: release.evidenceOutcome,
    }),
  );
  return release;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionApplicationReleaseFromEnvironment().catch((error) => {
    const message =
      error instanceof ProductionApplicationReleasePrerequisiteError
        ? error.message
        : "ProductionApplicationReleasePrerequisiteError: release failed";
    console.error(message);
    process.exitCode = 1;
  });
}

import { access, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  validateProductionRlsPolicyManifest,
  validateProductionRuntimeRoleReachabilityAllowlist,
} from "./production-migration-preflight";

type ProductionReleaseContract = Readonly<{
  ciCheck: string;
  ciWorkflow: string;
  hostedPreview: boolean;
  productionBranch: string;
  productionCustomDomain: string | null;
  productionDeploymentEnabled: boolean;
  productionDeploymentEvidenceSchema: string;
  productionDeploymentEvidenceSchemaSha256: string;
  productionDeploymentModel: string;
  productionDeploymentSourceManifestBuilder: string;
  productionDeploymentSourceManifestBuilderSha256: string;
  productionDeploymentSourceManifestSchema: string;
  productionDeploymentSourceManifestSchemaSha256: string;
  productionDeploymentRequiredSecrets: ReadonlyArray<string>;
  productionDeploymentRequiredVariables: ReadonlyArray<string>;
  productionDeploymentStatus: string;
  productionDeploymentWriter: string;
  productionRestoreEvidenceSchema: string;
  productionRestoreEvidenceSchemaSha256: string;
  productionRestoreModel: string;
  productionRestoreModelSha256: string;
  productionSmokeContract: string;
  productionSmokeContractSha256: string;
  productionSmokeModel: string;
  productionSmokeModelSha256: string;
  productionSmokePrincipalStatus: string;
  productionEnvironment: string;
  productionSchemaWriter: string;
  repository: string;
  supabaseGitProductionBranch: string;
  supabaseProjectRef: string;
  supabaseRegion: string;
  vercelGitDeployment: boolean;
  vercelDeploymentCliCandidateVersion: string;
  vercelDeploymentCliStatus: string;
  vercelDeploymentAdapterEvaluation: string;
  vercelDeploymentAdapter: string;
  vercelDeploymentAdapterSha256: string;
  vercelDeploymentAdapterStatus: string;
  stagedProductionSafetyStatus: string;
  vercelProjectId: string;
  vercelProjectName: string;
  vercelRestTransport: string;
  vercelRestTransportSha256: string;
  vercelSettingsReadAdapter: string;
  vercelSettingsReadStatus: string;
  vercelTeamId: string;
}>;

const CONTRACT_PATH = ".github/production-release-contract.json";
const PRODUCTION_RELEASE_DOC_PATH = "docs/deployment/production-release.md";
const RLS_POLICY_MANIFEST_PATH = ".github/production-rls-policy-manifest.json";
const WORKFLOW_PATH = ".github/workflows/production-release.yml";
const RUNNER_PATH = "scripts/production-migration-runner.ts";
const RELEASE_STATE_MACHINE_PATH = "scripts/production-migration-release.ts";

type JsonSchema = Readonly<{
  additionalProperties?: unknown;
  items?: unknown;
  maxItems?: unknown;
  pattern?: unknown;
  required?: unknown;
  properties?: Record<string, unknown>;
  uniqueItems?: unknown;
}>;

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ProductionReleaseContractError: ${message}`);
  }
}

type PackageSurface = Readonly<{
  dependencies?: Readonly<Record<string, unknown>>;
  devDependencies?: Readonly<Record<string, unknown>>;
  optionalDependencies?: Readonly<Record<string, unknown>>;
  peerDependencies?: Readonly<Record<string, unknown>>;
  scripts?: Readonly<Record<string, unknown>>;
}>;

const VERCEL_MUTATION_ENDPOINT =
  /\/v(?:2\/files|13\/deployments|10\/projects\/[^\s"']+\/promote|1\/projects\/[^\s"']+\/rollback)/i;
const VERCEL_MUTATION_SYMBOL =
  /\b(?:buildUploadVercelFileRequest|buildCreateVercelDeploymentRequest|buildPromoteVercelDeploymentRequest|buildRollbackVercelDeploymentRequest|createVercelDeploymentRestAdapter)\b/;
const VERCEL_CLI_MUTATION =
  /(?:^|[\s"'])(?:vercel\s+(?:deploy|promote|rollback)|(?:pnpm\s+(?:dlx|exec)|npx|npm\s+exec)[^\n]*\bvercel\b)/im;
const VERCEL_HTTP_MUTATION =
  /(?:\b(?:POST|PUT|PATCH|DELETE)\b[\s\S]{0,240}api\.vercel\.com|api\.vercel\.com[\s\S]{0,240}\b(?:POST|PUT|PATCH|DELETE)\b)/i;
const EXECUTABLE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|sh|py)$/i;
const SOURCE_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const SOURCE_SCAN_AUTHORIZED_CONTRACT_FILES = new Set([
  "scripts/check-production-release-contract.ts",
  "scripts/production-application-release.ts",
  "scripts/production-smoke-runner.ts",
  "scripts/vercel-deployment-rest-adapter.ts",
  "tests/unit/production-release-contract.test.ts",
  "tests/unit/vercel-deployment-rest-adapter.test.ts",
]);

export async function readRepositoryExecutableSources(
  root: string,
): Promise<Readonly<Record<string, string>>> {
  const sources: Record<string, string> = {};
  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visit(relativePath);
        }
        continue;
      }
      if (
        entry.isFile() &&
        EXECUTABLE_SOURCE_EXTENSION.test(entry.name) &&
        !SOURCE_SCAN_AUTHORIZED_CONTRACT_FILES.has(relativePath)
      ) {
        sources[relativePath] = await readFile(
          path.join(root, relativePath),
          "utf8",
        );
      }
    }
  }
  await visit("");
  return sources;
}

export function assertNoVercelDeploymentMutationEntrypoints({
  packageJson,
  scriptSources,
  workflowSources,
}: Readonly<{
  packageJson: PackageSurface;
  scriptSources: Readonly<Record<string, string>>;
  workflowSources: Readonly<Record<string, string>>;
}>): void {
  for (const dependencies of [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ]) {
    assertContract(
      dependencies?.vercel === undefined,
      "security-blocked Vercel CLI must not appear in any package dependency section",
    );
  }

  const packageCommands = Object.values(packageJson.scripts ?? {}).join("\n");
  assertContract(
    !VERCEL_CLI_MUTATION.test(packageCommands) &&
      !VERCEL_MUTATION_ENDPOINT.test(packageCommands) &&
      !VERCEL_MUTATION_SYMBOL.test(packageCommands) &&
      !packageCommands.includes("scripts/vercel-deployment-rest-adapter"),
    "package scripts must not expose a Vercel deployment mutation entrypoint",
  );

  for (const [filename, source] of Object.entries(workflowSources)) {
    assertContract(
      !VERCEL_CLI_MUTATION.test(source) &&
        !VERCEL_MUTATION_ENDPOINT.test(source) &&
        !VERCEL_MUTATION_SYMBOL.test(source) &&
        !VERCEL_HTTP_MUTATION.test(source),
      `workflow ${filename} must not expose a Vercel deployment mutation entrypoint`,
    );
  }

  for (const [filename, source] of Object.entries(scriptSources)) {
    assertContract(
      !VERCEL_MUTATION_ENDPOINT.test(source) &&
        !VERCEL_MUTATION_SYMBOL.test(source) &&
        !VERCEL_CLI_MUTATION.test(source) &&
        !VERCEL_HTTP_MUTATION.test(source),
      `script ${filename} must not expose a Vercel deployment mutation entrypoint`,
    );
  }
}

async function assertPinnedArtifact(
  root: string,
  artifactPath: string,
  expectedPath: string,
  expectedSha256: string,
  label: string,
): Promise<string> {
  assertContract(artifactPath === expectedPath, `${label} path is not repository-owned`);
  const text = await readFile(path.join(root, artifactPath), "utf8");
  assertContract(
    createHash("sha256").update(text).digest("hex") === expectedSha256,
    `${label} fingerprint does not match`,
  );
  return text;
}

export async function checkProductionReleaseContract(root: string) {
  const contract = JSON.parse(
    await readFile(path.join(root, CONTRACT_PATH), "utf8"),
  ) as ProductionReleaseContract;
  const vercelConfig = JSON.parse(
    await readFile(path.join(root, "vercel.json"), "utf8"),
  ) as { git?: { deploymentEnabled?: boolean } };
  const workflow = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
  const productionReleaseDoc = await readFile(
    path.join(root, PRODUCTION_RELEASE_DOC_PATH),
    "utf8",
  );
  const runner = await readFile(path.join(root, RUNNER_PATH), "utf8");
  const releaseStateMachine = await readFile(path.join(root, RELEASE_STATE_MACHINE_PATH), "utf8");
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as PackageSurface;
  const workflowDirectory = path.join(root, ".github/workflows");
  const workflowSources = Object.fromEntries(
    await Promise.all(
      (await readdir(workflowDirectory, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() && /\.ya?ml$/i.test(entry.name),
        )
        .map(async (entry) => [
          entry.name,
          await readFile(path.join(workflowDirectory, entry.name), "utf8"),
        ] as const),
    ),
  );
  const scriptSources = await readRepositoryExecutableSources(root);
  const deploymentAdapterEvaluation = JSON.parse(
    await readFile(
      path.join(root, contract.vercelDeploymentAdapterEvaluation),
      "utf8",
    ),
  ) as {
    candidateNodeEngine?: unknown;
    candidateVersion?: unknown;
    decision?: unknown;
    nextAdapter?: unknown;
    audit?: { critical?: unknown; high?: unknown };
  };
  const deploymentEvidenceSchemaText = await readFile(
    path.join(root, contract.productionDeploymentEvidenceSchema),
    "utf8",
  );
  const deploymentEvidenceSchema = JSON.parse(
    deploymentEvidenceSchemaText,
  ) as JsonSchema;
  const productionDeploymentModel = await readFile(
    path.join(root, contract.productionDeploymentModel),
    "utf8",
  );
  const vercelSettingsReadAdapter = await readFile(
    path.join(root, contract.vercelSettingsReadAdapter),
    "utf8",
  );
  const vercelRestTransport = await readFile(
    path.join(root, "scripts/vercel-rest-transport.ts"),
    "utf8",
  );
  assertNoVercelDeploymentMutationEntrypoints({
    packageJson,
    scriptSources,
    workflowSources,
  });
  const liveProductionSettingsChecker = await readFile(
    path.join(root, "scripts/check-live-production-settings.ts"),
    "utf8",
  );
  const rlsPolicyManifest = JSON.parse(
    await readFile(path.join(root, RLS_POLICY_MANIFEST_PATH), "utf8"),
  ) as { schema?: unknown; policies?: unknown };
  const ciWorkflow = await readFile(path.join(root, contract.ciWorkflow), "utf8");
  const ciWorkflowFilename = path.basename(contract.ciWorkflow);
  await validateProductionRlsPolicyManifest(root);
  await validateProductionRuntimeRoleReachabilityAllowlist(root);

  assertContract(contract.repository === "elekli/game-base", "repository must be elekli/game-base");
  assertContract(contract.productionBranch === "main", "production branch must be main");
  assertContract(contract.ciCheck === "verify", "required CI check must be verify");
  assertContract(contract.ciWorkflow === ".github/workflows/ci.yml", "CI workflow must be ci.yml");
  assertContract(contract.productionEnvironment === "Production", "GitHub environment must be Production");
  assertContract(contract.vercelProjectId === "prj_iTlWeDkcKItHTKYIayoNjQQ0vHec", "Vercel project ID does not match the Production binding");
  assertContract(contract.vercelProjectName === "game-base", "Vercel project name does not match the Production binding");
  assertContract(
    contract.vercelTeamId === "team_vpaufHhAabxSup7QLCbCGwlF",
    "Vercel team ID does not match the Production binding",
  );
  assertContract(
    contract.vercelDeploymentCliCandidateVersion === "59.11.7" &&
      contract.vercelDeploymentCliStatus === "blocked-security-audit" &&
      contract.vercelDeploymentAdapterEvaluation ===
        ".github/vercel-deployment-adapter-evaluation.json" &&
      deploymentAdapterEvaluation.candidateVersion ===
        contract.vercelDeploymentCliCandidateVersion &&
      deploymentAdapterEvaluation.candidateNodeEngine === ">= 18" &&
      deploymentAdapterEvaluation.audit?.critical === 1 &&
      deploymentAdapterEvaluation.audit?.high === 18 &&
      deploymentAdapterEvaluation.decision ===
        "blocked-no-executable-deployment-cli" &&
      deploymentAdapterEvaluation.nextAdapter ===
        "official-rest-api-or-security-cleared-exact-cli",
    "Vercel deployment CLI candidate must remain security-blocked with its audit evidence",
  );
  assertContract(
    packageJson.devDependencies?.vercel === undefined &&
      !/(?:pnpm\s+(?:dlx|exec)|npx)\s+vercel|\bvercel\s+(?:deploy|promote|rollback)\b/.test(
        Object.values(packageJson.scripts ?? {}).join("\n"),
      ),
    "security-blocked Vercel deployment CLI must not be executable through package dependencies or scripts",
  );
  assertContract(
    contract.vercelSettingsReadAdapter ===
      "scripts/vercel-read-only-rest-client.ts" &&
      contract.vercelSettingsReadStatus ===
        "ready-official-rest-read-only" &&
      vercelRestTransport.includes(
        'const VERCEL_API_ORIGIN = "https://api.vercel.com"',
      ) &&
      vercelSettingsReadAdapter.includes(
        '`/v10/projects/${encodeURIComponent(projectId)}/env`',
      ) &&
      vercelSettingsReadAdapter.includes(
        '`/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variableId)}`',
      ) &&
      vercelSettingsReadAdapter.includes(
        '`/v9/projects/${encodeURIComponent(projectId)}`',
      ) &&
      !/method:\s*"(?:POST|PUT|PATCH|DELETE)"|\/deployments|\/promote|\/rollback/.test(
        vercelSettingsReadAdapter,
      ) &&
      !/readJsonSafely\("vercel"|execFile(?:Sync)?\("vercel"/.test(
        liveProductionSettingsChecker,
      ),
    "Vercel settings inspection must use the repository-owned official REST read adapter",
  );
  assertContract(
    contract.productionDeploymentWriter ===
      ".github/workflows/production-application-release.yml",
    "Production application deployment writer must use the protected workflow path",
  );
  await assertPinnedArtifact(root, contract.productionDeploymentSourceManifestBuilder, "scripts/production-deployment-source-manifest.ts", contract.productionDeploymentSourceManifestBuilderSha256, "source manifest builder");
  await assertPinnedArtifact(root, contract.productionDeploymentSourceManifestSchema, ".github/production-deployment-source-manifest.schema.json", contract.productionDeploymentSourceManifestSchemaSha256, "source manifest schema");
  await assertPinnedArtifact(root, contract.productionSmokeContract, ".github/production-smoke-contract.json", contract.productionSmokeContractSha256, "smoke contract");
  await assertPinnedArtifact(root, contract.productionSmokeModel, "scripts/production-smoke-canary.ts", contract.productionSmokeModelSha256, "smoke model");
  await assertPinnedArtifact(root, contract.productionRestoreModel, "scripts/production-restore-drill.ts", contract.productionRestoreModelSha256, "restore model");
  await assertPinnedArtifact(root, contract.productionRestoreEvidenceSchema, ".github/production-restore-drill-evidence.schema.json", contract.productionRestoreEvidenceSchemaSha256, "restore evidence schema");
  await assertPinnedArtifact(root, contract.vercelDeploymentAdapter, "scripts/vercel-deployment-rest-adapter.ts", contract.vercelDeploymentAdapterSha256, "Vercel deployment adapter");
  await assertPinnedArtifact(root, contract.vercelRestTransport, "scripts/vercel-rest-transport.ts", contract.vercelRestTransportSha256, "Vercel REST transport");
  assertContract(
    JSON.stringify([
      contract.productionDeploymentSourceManifestBuilderSha256,
      contract.productionDeploymentSourceManifestSchemaSha256,
      contract.vercelDeploymentAdapterSha256,
      contract.vercelRestTransportSha256,
      contract.productionSmokeContractSha256,
      contract.productionSmokeModelSha256,
      contract.productionRestoreModelSha256,
      contract.productionRestoreEvidenceSchemaSha256,
    ]) === JSON.stringify([
      "2d6e5c5f805cf8a39ae186bebf63535bf128039d9b1b52ea6f478e879df90a67",
      "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      "92f6d87f6c001020ee5a1780a5b3be3a7473b503cb34bd74e82f734ab6d83a51",
      "7a0c7d4facaf30bdd2b3fd0581465fe036bc10393f360218b9969e61acaa6183",
      "30301fbfa2b15ca5a0e33a65fcb68998ce5bbf112e9499baca21ca1ef9b37166",
      "f2062c6830759da1bcf7799156c2231b348fad20f105f1a72851d01d838f7d84",
      "4bedd522a39f3792141ebb79d83a6b3d461c3a53e5ce28f1bbfd4c6de4323ae8",
      "b801b6e3e46f64c3e273c33b5c3c3432ebc152247900e125459f2cecc5613d40",
    ]),
    "Production deployment artifact fingerprints must remain fixed",
  );
  const sourceManifestSchema = JSON.parse(
    await readFile(path.join(root, contract.productionDeploymentSourceManifestSchema), "utf8"),
  ) as JsonSchema;
  const smokeContract = JSON.parse(
    await readFile(path.join(root, contract.productionSmokeContract), "utf8"),
  ) as Record<string, unknown>;
  const restoreEvidenceSchema = JSON.parse(
    await readFile(path.join(root, contract.productionRestoreEvidenceSchema), "utf8"),
  ) as JsonSchema;
  const exactSmokeChecks = [
    "custom-domain-owner-access", "direct-origin-denied",
    "authenticated-library-read", "runtime-database-read",
    "private-storage-direct-denied", "canary-row-round-trip",
    "canary-object-round-trip", "canary-cleanup-counts",
  ];
  assertContract(
    sourceManifestSchema.additionalProperties === false &&
      (sourceManifestSchema.properties?.schemaVersion as { const?: unknown } | undefined)?.const === 1 &&
      JSON.stringify(sourceManifestSchema.required) === JSON.stringify(["schemaVersion", "commitSha", "files"]) &&
      (sourceManifestSchema.properties?.files as {
        maxItems?: unknown;
        "x-maxTotalBytes"?: unknown;
        items?: {
          properties?: {
            path?: { maxLength?: unknown; "x-maxUtf8Bytes"?: unknown };
            size?: { maximum?: unknown };
          };
        };
      } | undefined)?.maxItems === 20_000 &&
      (sourceManifestSchema.properties?.files as { "x-maxTotalBytes"?: unknown } | undefined)?.["x-maxTotalBytes"] === 1024 * 1024 * 1024 &&
      (sourceManifestSchema.properties?.files as { items?: { properties?: { path?: { maxLength?: unknown; "x-maxUtf8Bytes"?: unknown } } } } | undefined)?.items?.properties?.path?.maxLength === 1024 &&
      (sourceManifestSchema.properties?.files as { items?: { properties?: { path?: { "x-maxUtf8Bytes"?: unknown } } } } | undefined)?.items?.properties?.path?.["x-maxUtf8Bytes"] === 1024 &&
      (sourceManifestSchema.properties?.files as { items?: { properties?: { size?: { maximum?: unknown } } } } | undefined)?.items?.properties?.size?.maximum === 50 * 1024 * 1024,
    "Source manifest schema must remain closed and versioned",
  );
  assertContract(
    smokeContract.contractVersion === 1 &&
      smokeContract.namespace === "release-smoke-v1" &&
      JSON.stringify(smokeContract.checks) === JSON.stringify(exactSmokeChecks),
    "Production smoke contract constants must remain fixed",
  );
  assertContract(
    restoreEvidenceSchema.additionalProperties === false &&
      (restoreEvidenceSchema.properties?.outcome as { const?: unknown } | undefined)?.const === "passed" &&
      (restoreEvidenceSchema.properties?.storageBinariesIncluded as { const?: unknown } | undefined)?.const === false,
    "Restore evidence must remain closed and exclude Storage binaries",
  );
  const adapterModule = await import(
    pathToFileURL(path.join(root, contract.vercelDeploymentAdapter)).href
  );
  const sourceManifestModule = await import(
    pathToFileURL(
      path.join(root, contract.productionDeploymentSourceManifestBuilder),
    ).href
  );
  assertContract(
    contract.vercelDeploymentAdapterStatus === "request-contract-ready-live-mutations-disabled" &&
      contract.stagedProductionSafetyStatus === "auto-assign-disablement-unverified" &&
      typeof adapterModule.buildCreateVercelDeploymentRequest === "function" &&
      typeof adapterModule.buildPromoteVercelDeploymentRequest === "function" &&
      typeof adapterModule.buildRollbackVercelDeploymentRequest === "function" &&
      typeof adapterModule.parseReadyVercelProductionDeployment === "function",
    "Vercel REST request contract must remain explicit and closed",
  );
  let mutationDisabled = false;
  try {
    adapterModule.createVercelDeploymentRestAdapter();
  } catch (error) {
    mutationDisabled = error?.constructor?.name === "VercelDeploymentMutationDisabledError";
  }
  assertContract(mutationDisabled, "Vercel REST adapter must fail closed before live mutation");
  const disabledCreateArtifact =
    sourceManifestModule.canonicalizeProductionDeploymentSourceManifest({
      schemaVersion: 1,
      commitSha: "a".repeat(40),
      files: [],
    });
  let createDisabled = false;
  try {
    adapterModule.buildCreateVercelDeploymentRequest({
      projectName: contract.vercelProjectName,
      releaseIdentity: `production:${"a".repeat(40)}`,
      sourceManifestArtifact: disabledCreateArtifact,
    });
  } catch (error) {
    createDisabled =
      error?.constructor?.name ===
      "VercelStagedProductionSafetyUnverifiedError";
  }
  assertContract(
    createDisabled,
    "Vercel create request must remain disabled while staged safety is unverified",
  );
  assertContract(
    contract.productionDeploymentModel ===
      "scripts/production-deployment-release.ts" &&
      !/node:child_process|execFile|spawn\(|VERCEL_TOKEN|schema-rollback/.test(
        productionDeploymentModel,
      ),
    "Production deployment model must remain pure and must not expose schema rollback or live credentials",
  );
  assertContract(
    contract.productionDeploymentStatus ===
      "blocked-external-prerequisites-and-staging-safety-verification" &&
      contract.productionSmokePrincipalStatus === "unresolved" &&
      contract.productionCustomDomain === null &&
      contract.productionDeploymentEnabled === false,
    "Production application deployment must fail closed until its external prerequisites exist",
  );
  assertContract(
    JSON.stringify(contract.productionDeploymentRequiredSecrets) ===
      JSON.stringify([
        "VERCEL_TOKEN",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET",
      ]) &&
      JSON.stringify(contract.productionDeploymentRequiredVariables) ===
        JSON.stringify([
          "VERCEL_ORG_ID",
          "VERCEL_PROJECT_ID",
          "PRODUCTION_CUSTOM_DOMAIN",
        ]),
    "Production application deployment prerequisite names must stay fixed and secret-free",
  );
  assertContract(
    contract.productionDeploymentEvidenceSchema ===
      ".github/production-deployment-evidence.schema.json",
    "Production deployment evidence schema path is not repository-owned",
  );
  assertContract(
    contract.productionDeploymentEvidenceSchemaSha256 ===
      "4c0a1f5fa6b1ddd54f090e66b24bf11d90b0a6fe1d87dd587d43c23e99a41f8b" &&
      createHash("sha256").update(deploymentEvidenceSchemaText).digest("hex") ===
        contract.productionDeploymentEvidenceSchemaSha256,
    "Production deployment evidence schema fingerprint does not match the approved redaction boundary",
  );
  let applicationWriterExists = true;
  try {
    await access(path.join(root, contract.productionDeploymentWriter));
  } catch {
    applicationWriterExists = false;
  }
  assertContract(
    applicationWriterExists,
    "Production application deployment writer must be repository-owned",
  );
  const applicationWorkflow = await readFile(
    path.join(root, contract.productionDeploymentWriter),
    "utf8",
  );
  assertContract(
    applicationWorkflow.includes("Verify exact current main commit and successful CI") &&
      applicationWorkflow.includes("name: Production") &&
      applicationWorkflow.includes("pnpm release:migration:verify") &&
      applicationWorkflow.includes("pnpm release:application:run") &&
      !VERCEL_CLI_MUTATION.test(applicationWorkflow) &&
      !VERCEL_MUTATION_ENDPOINT.test(applicationWorkflow),
    "Production application writer must keep exact-main, strict migration, protected environment, and repository executor gates",
  );
  const evidenceFields = [
    "schemaVersion",
    "repository",
    "workflowRunId",
    "workflowRunAttempt",
    "executionSha",
    "releaseIdentity",
    "sourceManifestSha256",
    "canaryContractVersion",
    "releaseKind",
    "migrationTail",
    "baselineDeploymentId",
    "stagedDeploymentId",
    "productionDomain",
    "startedAt",
    "completedAt",
    "outcome",
    "promotionAttempts",
    "rollbackOutcome",
    "rollbackAttempts",
    "smoke",
  ];
  const evidenceRequired = deploymentEvidenceSchema.required;
  const evidenceProperties = deploymentEvidenceSchema.properties;
  assertContract(
    deploymentEvidenceSchema.additionalProperties === false &&
      Array.isArray(evidenceRequired) &&
      JSON.stringify([...evidenceRequired].sort()) ===
        JSON.stringify([...evidenceFields].sort()) &&
      evidenceProperties !== undefined &&
      JSON.stringify(Object.keys(evidenceProperties).sort()) ===
        JSON.stringify([...evidenceFields].sort()),
    "Production deployment evidence must use the exact secret-free field allowlist",
  );
  const smokeSchema = evidenceProperties.smoke as JsonSchema | undefined;
  assertContract(
    smokeSchema?.additionalProperties === false &&
      JSON.stringify(Object.keys(smokeSchema.properties ?? {}).sort()) ===
        JSON.stringify(["checks", "counts", "outcome", "requestIds"]),
    "Production smoke evidence must reject payloads and unknown fields",
  );
  const smokeRequestIds = smokeSchema?.properties?.requestIds as JsonSchema | undefined;
  const smokeRequestIdItems = smokeRequestIds?.items as JsonSchema | undefined;
  assertContract(
    smokeRequestIds?.maxItems === 16 &&
      smokeRequestIds?.uniqueItems === true &&
      smokeRequestIdItems?.pattern ===
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    "Production smoke evidence must accept at most 16 unique UUIDv4 request IDs",
  );
  const smokeChecks = (smokeSchema?.properties?.checks as JsonSchema | undefined);
  assertContract(
    smokeChecks?.additionalProperties === false &&
      JSON.stringify(Object.keys(smokeChecks.properties ?? {})) === JSON.stringify([
        "custom-domain-owner-access", "direct-origin-denied",
        "authenticated-library-read", "runtime-database-read",
        "private-storage-direct-denied", "canary-row-round-trip",
        "canary-object-round-trip", "canary-cleanup-counts",
      ]),
    "Production smoke evidence must pin the complete eight-check canary contract",
  );
  assertContract(contract.supabaseProjectRef === "wbtyuvufhrhybquzwfip", "Supabase project ref does not match the Production binding");
  assertContract(contract.supabaseRegion === "ap-south-1", "Supabase region does not match the Production binding");
  assertContract(
    contract.supabaseGitProductionBranch ===
      "production-deploy-disabled-use-github-actions",
    "Supabase Git production mapping must remain on the disabled sentinel",
  );
  assertContract(
    contract.productionSchemaWriter === WORKFLOW_PATH,
    "Production schema writer must be the protected release workflow",
  );
  assertContract(
    productionReleaseDoc.includes(contract.supabaseGitProductionBranch) &&
      productionReleaseDoc.includes(
        `Production schema 的唯一支援寫入者是 \`${contract.productionSchemaWriter}\``,
      ) &&
      productionReleaseDoc.includes(
        "CI 無法查證 Supabase 外部 integration 的實際 mapping",
      ),
    "Production release documentation must preserve the Supabase Git sentinel and external-state boundary",
  );
  assertContract(
    productionReleaseDoc.includes("productionDeploymentEnabled: false") &&
      productionReleaseDoc.includes(contract.productionDeploymentWriter) &&
      productionReleaseDoc.includes(contract.productionDeploymentEvidenceSchema) &&
      productionReleaseDoc.includes("資料庫 schema 永不隨 application rollback 回滾") &&
      productionReleaseDoc.includes("Promotion 與 rollback 各最多 2 次"),
    "Production release documentation must preserve the disabled bounded deployment model",
  );
  assertContract(contract.hostedPreview === false, "Hosted Preview must remain disabled");
  assertContract(contract.vercelGitDeployment === false, "Vercel Git deployment must remain disabled");
  assertContract(
    rlsPolicyManifest.schema === "app_private" &&
      Array.isArray(rlsPolicyManifest.policies) &&
      rlsPolicyManifest.policies.length > 0,
    "release must own a non-empty app_private RLS policy manifest",
  );
  assertContract(
    vercelConfig.git?.deploymentEnabled === false,
    "vercel.json must disable Git deployments",
  );
  assertContract(/^\s{4}environment:\n\s{6}name: Production$/m.test(workflow), "release job must use the protected Production environment");
  const trustedCheckout = workflow.indexOf("ref: main");
  const verification = workflow.indexOf("Verify exact current main commit and successful CI");
  const candidateCheckout = workflow.indexOf('git checkout --detach "$EXECUTION_SHA"');
  const repositoryScripts = workflow.indexOf("pnpm install --frozen-lockfile");
  const migrationOrchestrator = workflow.indexOf("pnpm release:migration:run");
  const persistedPlanStep = workflow.indexOf("Persist exact migration plan");
  const planArtifactStep = workflow.indexOf("production-migration-plan-${{ github.run_id }}-${{ github.run_attempt }}");
  const authorizationStep = workflow.indexOf("Authorize exact migration attempt");
  const applyOrchestratorStep = workflow.indexOf("Apply and strict-verify exact migration suffix");
  const recordStep = workflow.indexOf("Create sanitized evidence and ledger");
  const mutationJob = workflow.indexOf("  mutate-production:");
  const mutationSteps = workflow.indexOf("    steps:", mutationJob);
  const mutationCheckout = workflow.indexOf("- uses: actions/checkout@v4", mutationSteps);
  const pinnedExecutionCheck = workflow.indexOf("Confirm pinned execution is still current main", mutationCheckout);
  const tempPathSetup = workflow.indexOf("Configure release temp paths", mutationCheckout);
  const packageManagerSetup = workflow.indexOf("- uses: pnpm/action-setup@v4", mutationCheckout);
  assertContract(trustedCheckout >= 0, "workflow must check out trusted main first");
  assertContract(
    !workflow.includes("ref: ${{ inputs.commit_sha }}"),
    "workflow must not initially check out an unverified candidate",
  );
  assertContract(
    mutationJob > verification &&
      !workflow.slice(0, mutationJob).includes("secrets.") &&
      !workflow.slice(0, mutationJob).includes("    environment:"),
    "candidate verification must not use the Production environment or secrets",
  );
  assertContract(
    workflow.includes(
      `actions/workflows/${ciWorkflowFilename}/runs?head_sha=\${execution_sha}`,
    ),
    "release gate must query the configured CI workflow for the pinned execution commit",
  );
  assertContract(/test "\$execution_sha" = "\$COMMIT_SHA"/.test(workflow), "apply candidate must equal the execution commit");
  assertContract(workflow.includes('git merge-base --is-ancestor "$source_sha" "$execution_sha"'), "recovery source must be an ancestor of the execution commit");
  assertContract(/\.head_branch == "main"/.test(workflow), "release gate must require a main workflow run");
  assertContract(/\.event == "push"/.test(workflow), "release gate must require a push workflow run");
  assertContract(/\.conclusion == "success"/.test(workflow), "release gate must require a successful workflow run");
  assertContract(
    verification > trustedCheckout &&
      candidateCheckout > verification &&
      repositoryScripts > candidateCheckout &&
      migrationOrchestrator > repositoryScripts,
    "candidate checkout and repository scripts must follow trust verification",
  );
  assertContract(
    workflow.includes("PRODUCTION_MIGRATION_DATABASE_URL: ${{ secrets.PRODUCTION_MIGRATION_DATABASE_URL }}"),
    "migration preflight must receive its connection only from the Production Environment secret",
  );
  assertContract(
    workflow.includes("PRODUCTION_MIGRATION_CA_CERT: ${{ secrets.PRODUCTION_MIGRATION_CA_CERT }}"),
    "migration preflight must receive its CA certificate from the Production Environment secret",
  );
  assertContract(
    ciWorkflow.includes("pnpm release:migrations:lint --baseline-ref origin/main") &&
      /fetch-depth:\s*0/.test(ciWorkflow),
    "CI must compare the destructive-migration baseline with trusted main history",
  );
  assertContract(
    workflow.indexOf("environment:\n      name: Production") >
      workflow.indexOf("verify-release-candidate:"),
    "Production approval must follow candidate verification",
  );
  for (const required of [
    "pending_migrations_json:",
    "source_run_attempt:",
    "candidate_sha:",
    "source_sha:",
    "execution_sha:",
    "CANDIDATE_SHA: ${{ needs.verify-release-candidate.outputs.candidate_sha }}",
    "SOURCE_SHA: ${{ needs.verify-release-candidate.outputs.source_sha }}",
    "Apply migration and preserve commit-bound ledger",
    "Confirm pinned execution is still current main",
    "Configure release temp paths",
    "Authorize exact migration attempt",
    "Apply and strict-verify exact migration suffix",
    "Create sanitized evidence and ledger",
    "pnpm release:migration:run",
    "SOURCE_ARTIFACT_ZIP_PATH",
    "/attempts/${SOURCE_RUN_ATTEMPT}/jobs",
    "production-migration-plan-${{ github.run_id }}-${{ github.run_attempt }}",
    "retention-days: 90",
    "ledger-recovery",
    "git merge-base --is-ancestor",
    "artifact identity mismatch",
    "pnpm release:migration:plan plan-from-input",
    "pnpm release:migration:run authorize",
    "pnpm release:migration:run apply",
    "pnpm release:migration:run ${{ inputs.mode == 'apply' && 'record' || 'recovery' }}",
    "pnpm release:migration:run publish-ledger",
    'echo "RELEASE_PLAN_PATH=$RUNNER_TEMP/preflight.json" >> "$GITHUB_ENV"',
    'echo "RELEASE_EVIDENCE_PATH=$RUNNER_TEMP/evidence/migration-release.json" >> "$GITHUB_ENV"',
    'echo "RELEASE_STATE_PATH=$RUNNER_TEMP/release-state.json" >> "$GITHUB_ENV"',
  ]) {
    assertContract(workflow.includes(required), `workflow is missing ${required}`);
  }
  assertContract(!workflow.includes("> \"$RUNNER_TEMP/preflight"), "machine preflight JSON must not be captured from pnpm stdout");
  assertContract(
    !/pnpm release:(?:migration:(?:plan|run)|migrations:lint) --(?:\s|$)/.test(`${workflow}\n${ciWorkflow}`),
    "workflow package scripts must not forward a literal argument separator",
  );
  assertContract(
    mutationSteps > mutationJob && !workflow.slice(mutationJob, mutationSteps).includes("runner.temp"),
    "job-level mutation env must not use the unavailable runner context",
  );
  assertContract(
    mutationCheckout >= mutationSteps && tempPathSetup > mutationCheckout && packageManagerSetup > tempPathSetup &&
      !workflow.slice(tempPathSetup, packageManagerSetup).includes("secrets."),
    "release temp paths must be configured early without secrets",
  );
  assertContract(
    workflow.slice(mutationCheckout, tempPathSetup).includes("ref: ${{ needs.verify-release-candidate.outputs.execution_sha }}") &&
      !workflow.slice(mutationCheckout, tempPathSetup).includes("ref: main") &&
      pinnedExecutionCheck > mutationCheckout &&
      workflow.slice(pinnedExecutionCheck, tempPathSetup).includes('test "$(git rev-parse HEAD)" = "$EXECUTION_SHA"') &&
      workflow.slice(pinnedExecutionCheck, tempPathSetup).includes('test "$(git rev-parse origin/main)" = "$EXECUTION_SHA"') &&
      !workflow.slice(mutationCheckout, tempPathSetup).includes("secrets."),
    "mutation must check out the exact execution commit instead of floating main",
  );
  assertContract(!workflow.includes("if: always()"), "record and publication steps must not run after mutation failure");
  assertContract((workflow.match(/- name: Apply and strict-verify exact migration suffix/g)?.length ?? 0) === 1, "mutation job must have one uniquely named apply and strict step");
  assertContract((workflow.match(/- name: Authorize exact migration attempt/g)?.length ?? 0) === 1, "mutation job must have one uniquely named authorization step");
  assertContract(
    !workflow.slice(authorizationStep, applyOrchestratorStep).includes("PRODUCTION_MIGRATION_DATABASE_URL") &&
      workflow.slice(authorizationStep, applyOrchestratorStep).includes("pnpm release:migration:run authorize"),
    "authorization step must validate the persisted identity without database access",
  );
  assertContract(
    persistedPlanStep >= 0 && planArtifactStep > persistedPlanStep && authorizationStep > planArtifactStep && applyOrchestratorStep > authorizationStep && recordStep > applyOrchestratorStep,
    "the persisted plan, authorization, mutation, and record steps must remain ordered",
  );
  assertContract(!workflow.includes("supabase migration up"), "workflow shell must delegate migration apply to the tested runner");
  assertContract(
    runner.includes('runAttempt: Number(job.run_attempt)') &&
      releaseStateMachine.includes('["success", "failure", "cancelled"].includes') &&
      !releaseStateMachine.includes('["success", "failure", "cancelled", "skipped"]') &&
      runner.includes('resolveMain(root, executionSha)') &&
      runner.includes('["ls-remote", "--exit-code", "--heads"') &&
      runner.includes('"headRefName,baseRefName,title,state,isDraft,mergedAt"') &&
      !runner.includes('"--force"') &&
      !runner.includes('"--force-with-lease"'),
    "runner must pin execution, reject unstarted source mutations, and publish deterministic ledgers without force push",
  );
  assertContract(
    !/vercel\s+(deploy|--prod)|supabase\s+(?:db\s+(?:push|reset)|migration\s+repair)/.test(
      workflow,
    ),
    "migration workflow must not reset, repair, db-push, or deploy",
  );

  return {
    ciCheck: contract.ciCheck,
    ciWorkflow: contract.ciWorkflow,
    productionEnvironment: contract.productionEnvironment,
    productionBranch: contract.productionBranch,
    vercelGitDeployment: contract.vercelGitDeployment,
  };
}

async function main() {
  const result = await checkProductionReleaseContract(process.cwd());
  console.log(JSON.stringify({ event: "production_release_contract_validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

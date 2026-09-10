import { readFile, readdir } from "node:fs/promises";
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
  productionApplicationRunner: string;
  productionApplicationRunnerSha256: string;
  productionApplicationStateRunner: string;
  productionApplicationStateRunnerSha256: string;
  productionDeploymentEvidenceWriter: string;
  productionDeploymentEvidenceWriterSha256: string;
  productionDeploymentEvidenceSchema: string;
  productionDeploymentEvidenceSchemaSha256: string;
  productionDeploymentModel: string;
  productionDeploymentModelSha256: string;
  productionDeploymentSourceManifestBuilder: string;
  productionDeploymentSourceManifestBuilderSha256: string;
  productionDeploymentSourceManifestSchema: string;
  productionDeploymentSourceManifestSchemaSha256: string;
  productionDeploymentRequiredSecrets: ReadonlyArray<string>;
  productionDeploymentRequiredVariables: ReadonlyArray<string>;
  productionDeploymentStatus: string;
  productionDeploymentWriter: string;
  productionDeploymentWriterSha256: string;
  productionRestoreEvidenceSchema: string;
  productionRestoreEvidenceSchemaSha256: string;
  productionRestoreModel: string;
  productionRestoreModelSha256: string;
  productionRestoreExecutor: string;
  productionRestoreExecutorSha256: string;
  productionRestoreIntegrityChecker: string;
  productionRestoreIntegrityCheckerSha256: string;
  productionRestoreRunner: string;
  productionRestoreRunnerSha256: string;
  productionRestoreWorkflow: string;
  productionRestoreWorkflowSha256: string;
  productionRestoreStatus: string;
  productionSmokeContract: string;
  productionSmokeContractSha256: string;
  productionSmokeModel: string;
  productionSmokeModelSha256: string;
  productionSmokePersistenceMigration: string;
  productionSmokePersistenceMigrationSha256: string;
  productionSmokePersistencePgtap: string;
  productionSmokePersistencePgtapSha256: string;
  productionSmokeRunner: string;
  productionSmokeRunnerSha256: string;
  productionSmokeRunnerStatus: string;
  productionSmokeAdapter: string;
  productionSmokeAdapterSha256: string;
  productionSmokePrincipalStatus: string;
  releaseSmokeAccessTokenVerifier: string;
  releaseSmokeAccessTokenVerifierSha256: string;
  releaseSmokeDeploymentBindings: string;
  releaseSmokeDeploymentBindingsSha256: string;
  releaseSmokeHandler: string;
  releaseSmokeHandlerSha256: string;
  releaseSmokeProductionAccessTokenVerifier: string;
  releaseSmokeProductionAccessTokenVerifierSha256: string;
  releaseSmokeRoute: string;
  releaseSmokeRouteSha256: string;
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
  "tests/unit/vercel-rest-transport.test.ts",
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

export type ReleaseSmokeAuthArtifactContract = Pick<
  ProductionReleaseContract,
  | "releaseSmokeAccessTokenVerifier"
  | "releaseSmokeAccessTokenVerifierSha256"
  | "releaseSmokeDeploymentBindings"
  | "releaseSmokeDeploymentBindingsSha256"
  | "releaseSmokeHandler"
  | "releaseSmokeHandlerSha256"
  | "releaseSmokeProductionAccessTokenVerifier"
  | "releaseSmokeProductionAccessTokenVerifierSha256"
  | "releaseSmokeRoute"
  | "releaseSmokeRouteSha256"
>;

export async function assertReleaseSmokeAuthArtifactsPinned(
  root: string,
  contract: ReleaseSmokeAuthArtifactContract,
) {
  await assertPinnedArtifact(
    root,
    contract.releaseSmokeRoute,
    "src/app/api/internal/release-smoke/route.ts",
    contract.releaseSmokeRouteSha256,
    "release-smoke route",
  );
  await assertPinnedArtifact(
    root,
    contract.releaseSmokeHandler,
    "src/app/api/internal/release-smoke/handler.ts",
    contract.releaseSmokeHandlerSha256,
    "release-smoke handler",
  );
  await assertPinnedArtifact(
    root,
    contract.releaseSmokeAccessTokenVerifier,
    "src/shared/auth/verify-release-smoke-access-token.ts",
    contract.releaseSmokeAccessTokenVerifierSha256,
    "release-smoke access token verifier",
  );
  await assertPinnedArtifact(
    root,
    contract.releaseSmokeProductionAccessTokenVerifier,
    "src/shared/auth/production-release-smoke-access-token-verifier.ts",
    contract.releaseSmokeProductionAccessTokenVerifierSha256,
    "release-smoke production verifier provider",
  );
  await assertPinnedArtifact(
    root,
    contract.releaseSmokeDeploymentBindings,
    "src/shared/config/deployment-bindings.ts",
    contract.releaseSmokeDeploymentBindingsSha256,
    "release-smoke deployment bindings",
  );
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
    liveMutationEnabled?: unknown;
    nextAdapter?: unknown;
    restCreateSkipDomainEquivalent?: unknown;
    restRequestContractStatus?: unknown;
    stagedProductionSafetyStatus?: unknown;
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
  const productionApplicationWorkflow = await assertPinnedArtifact(
    root,
    contract.productionDeploymentWriter,
    ".github/workflows/production-application-release.yml",
    contract.productionDeploymentWriterSha256,
    "Production application workflow",
  );
  await assertPinnedArtifact(
    root,
    contract.productionApplicationRunner,
    "scripts/production-application-release.ts",
    contract.productionApplicationRunnerSha256,
    "Production application runner",
  );
  await assertPinnedArtifact(
    root,
    contract.productionApplicationStateRunner,
    "scripts/production-application-release-runner.ts",
    contract.productionApplicationStateRunnerSha256,
    "Production application state runner",
  );
  await assertPinnedArtifact(
    root,
    contract.productionDeploymentEvidenceWriter,
    "scripts/production-deployment-evidence.ts",
    contract.productionDeploymentEvidenceWriterSha256,
    "Production deployment evidence writer",
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
        "official-rest-api-or-security-cleared-exact-cli" &&
      deploymentAdapterEvaluation.restRequestContractStatus ===
        "request-contract-ready-protected-live-mutations" &&
      deploymentAdapterEvaluation.stagedProductionSafetyStatus ===
        "verified-auto-assign-disabled" &&
      deploymentAdapterEvaluation.restCreateSkipDomainEquivalent === false &&
      deploymentAdapterEvaluation.liveMutationEnabled === true,
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
      vercelSettingsReadAdapter.includes(
        '`/v9/projects/${encodeURIComponent(projectId)}/domains`',
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
  await assertPinnedArtifact(root, contract.productionDeploymentModel, "scripts/production-deployment-release.ts", contract.productionDeploymentModelSha256, "production deployment model");
  await assertPinnedArtifact(root, contract.productionSmokeContract, ".github/production-smoke-contract.json", contract.productionSmokeContractSha256, "smoke contract");
  await assertPinnedArtifact(root, contract.productionSmokeModel, "scripts/production-smoke-canary.ts", contract.productionSmokeModelSha256, "smoke model");
  await assertPinnedArtifact(root, contract.productionSmokePersistenceMigration, "supabase/migrations/0015_production_smoke_canary.sql", contract.productionSmokePersistenceMigrationSha256, "smoke persistence migration");
  await assertPinnedArtifact(root, contract.productionSmokePersistencePgtap, "supabase/tests/0015_production_smoke_canary.pgtap.sql", contract.productionSmokePersistencePgtapSha256, "smoke persistence pgTAP");
  await assertPinnedArtifact(root, contract.productionSmokeRunner, "scripts/production-smoke-runner.ts", contract.productionSmokeRunnerSha256, "smoke runner");
  await assertPinnedArtifact(root, contract.productionSmokeAdapter, "src/adapters/production-smoke-canary-adapter.ts", contract.productionSmokeAdapterSha256, "smoke adapter");
  assertContract(
    contract.productionSmokeRunnerStatus === "ready-protected-live-production",
    "smoke runner must be enabled only behind the protected Production workflow",
  );
  await assertReleaseSmokeAuthArtifactsPinned(root, contract);
  await assertPinnedArtifact(root, contract.productionRestoreModel, "scripts/production-restore-drill.ts", contract.productionRestoreModelSha256, "restore model");
  await assertPinnedArtifact(root, contract.productionRestoreExecutor, "scripts/production-restore-executor.ts", contract.productionRestoreExecutorSha256, "restore executor");
  await assertPinnedArtifact(root, contract.productionRestoreIntegrityChecker, "scripts/check-production-restore-integrity.ts", contract.productionRestoreIntegrityCheckerSha256, "restore integrity checker");
  await assertPinnedArtifact(root, contract.productionRestoreRunner, "scripts/production-restore.ts", contract.productionRestoreRunnerSha256, "restore runner");
  await assertPinnedArtifact(root, contract.productionRestoreWorkflow, ".github/workflows/production-restore-drill.yml", contract.productionRestoreWorkflowSha256, "restore workflow");
  await assertPinnedArtifact(root, contract.productionRestoreEvidenceSchema, ".github/production-restore-drill-evidence.schema.json", contract.productionRestoreEvidenceSchemaSha256, "restore evidence schema");
  assertContract(contract.productionRestoreStatus === "ready-protected-manual", "restore runner must be ready behind the protected manual workflow");
  await assertPinnedArtifact(root, contract.vercelDeploymentAdapter, "scripts/vercel-deployment-rest-adapter.ts", contract.vercelDeploymentAdapterSha256, "Vercel deployment adapter");
  await assertPinnedArtifact(root, contract.vercelRestTransport, "scripts/vercel-rest-transport.ts", contract.vercelRestTransportSha256, "Vercel REST transport");
  assertContract(
    JSON.stringify([
      contract.productionDeploymentSourceManifestBuilderSha256,
      contract.productionDeploymentSourceManifestSchemaSha256,
      contract.productionDeploymentModelSha256,
      contract.productionDeploymentWriterSha256,
      contract.productionApplicationRunnerSha256,
      contract.productionApplicationStateRunnerSha256,
      contract.productionDeploymentEvidenceWriterSha256,
      contract.vercelDeploymentAdapterSha256,
      contract.vercelRestTransportSha256,
      contract.productionSmokeContractSha256,
      contract.productionSmokeModelSha256,
      contract.productionSmokePersistenceMigrationSha256,
      contract.productionSmokePersistencePgtapSha256,
      contract.productionSmokeRunnerSha256,
      contract.productionSmokeAdapterSha256,
      contract.releaseSmokeRouteSha256,
      contract.releaseSmokeHandlerSha256,
      contract.releaseSmokeAccessTokenVerifierSha256,
      contract.releaseSmokeProductionAccessTokenVerifierSha256,
      contract.releaseSmokeDeploymentBindingsSha256,
      contract.productionRestoreModelSha256,
      contract.productionRestoreExecutorSha256,
      contract.productionRestoreIntegrityCheckerSha256,
      contract.productionRestoreRunnerSha256,
      contract.productionRestoreWorkflowSha256,
      contract.productionRestoreEvidenceSchemaSha256,
    ]) === JSON.stringify([
      "589afce50b16f0d4e6896ad091b9621a96065ad6f2a15c7d9c16d7e95ed1405a",
      "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      "e491156ff423e03872d95175236f86f3cde936b3254fe81d706e53776a96d093",
      "e7524b3fe9c020c2e7970301d90a849a08a6ec0ae81538d3ac2755e5c7d77746",
      "6cbaa7e9bddcf9db00e5fc364c3625a097fa129a58d422081f90f2b87815add3",
      "c329cc1605f0a9eda2d6df16d55a7c2eae6c698ea56373e7044cf88813589b07",
      "749bcc8f8bc3a494b8b526c005d28ce5169da312b8e9a17e35694ef30f2155f4",
      "fcea0fd520df434b1c549e0d7b848530c60b43b87711814dae6f6ff3ffa464c3",
      "92569dcc9e85de5efe083da1ddf7951326ae3793ccfe535fda7024aedde139d4",
      "aab60949aa19dbec335d9012ce10d751a273bc244b35bab9bdc10861892f83ea",
      "618cf243e1214778e6b0b9b437913f69e56af09bd1d0cd445fa0f2fae33e7ba9",
      "ecc8b4b53f319f877a3e5dc50d9690e1a36d94d5ee123d81d33a4eb1820687f8",
      "f1cc8366f5dafa9b9aa28fa7334c9a2e4ffa555e6e62b7e0f09d7d31eb8998e3",
      "c7879f56fd6ab185c27e3719edc3bec83ca47b93abc7040f43261fb0d5ccd241",
      "8d7ce463b3f7050795926b919b4e09edb8ea80720b6fe1de75324c7aa55351d9",
      "b2e22f7ffb8089ae408c201ef9da20ec5249ca4afc7256b74741bd232457486c",
      "bd090591c481088c9202b089ad5af2a4a8ce71b8282104fc4b3dd9329202ed98",
      "185701f85c21333153a6b8655df22dfd10545061ccd27e771033fe1196c8b767",
      "2a1463331e350d5284f75ae7eb51ebbf7da74e0951b826a4e21130f2b4648b76",
      "cf273ce015681fb1c9e92d2a322c0b93fdc9552e28b93b56553adf045938402c",
      "96604eb799d32eefff62297efafe8e18cca595cc6d4505083f60ead85402f028",
      "bdeb49c6fa4f0d67e9b2135454c85e44b658729484e815db43e38fe4fbed53d5",
      "60a12f3fa541ff0dbbc14ee0c954893648d4a6b01d1a3a67bd23faafa9b6ee28",
      "2ae2be12554e82d36220558a17ade62600c823a38efd72bbda8148d6ecbb7558",
      "28cf4c2e32761df2692ef234c103944beb4b267512f577b1a5d3ccbb7c826974",
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
    "canary-object-round-trip", "private-media-original-read",
    "media-thumbnail-generated", "private-media-thumbnail-read",
    "canary-cleanup-counts",
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
    smokeContract.contractVersion === 4 &&
      smokeContract.namespace === "release-smoke-v1" &&
      JSON.stringify(smokeContract.objectPaths) === JSON.stringify([
        "release-smoke-v1/original.png",
        "release-smoke-v1/thumbnail.webp",
      ]) &&
      JSON.stringify(smokeContract.payloadHashInput) === JSON.stringify([
        "namespace", "identity", "rowId", "objectPaths",
      ]) &&
      JSON.stringify(smokeContract.bounds) === JSON.stringify({
        baseline: { row: 0, object: 0 },
        mutationMaximum: { row: 1, object: 2 },
        cleanup: { row: 0, object: 0 },
      }) &&
      smokeContract.generationFormat === "uuid-v4-created-once-per-complete-attempt" &&
      smokeContract.actionSequenceFormat ===
        "positive-integer-starting-at-1-incremented-on-every-next-action" &&
      JSON.stringify(smokeContract.persistedPhases) === JSON.stringify([
        "row_claimed", "object_write_pending", "object_written",
        "object_write_uncertain", "cleanup_pending", "cleanup_uncertain",
      ]) &&
      JSON.stringify(smokeContract.residuePolicy) === JSON.stringify({
        automaticCleanup: [
          "same-generation exact 1/0 row_claimed residue",
          "same-generation byte-exact partial 1/1 removed inside definitive write failure handling",
          "same-generation exact 1/2 object_written residue",
        ],
        stop: [
          "0/1-2 object-only residue",
          "any persisted partial 1/1 media residue",
          "different generation, identity, or payload hash",
          "object_write_uncertain or cleanup_uncertain",
        ],
      }) &&
      JSON.stringify(smokeContract.stateEvents) === JSON.stringify([
        "counts-observed", "fixed-read-checks-observed", "row-written",
        "object-written", "round-trip-observed",
        "private-storage-denial-observed", "cleanup-finished", "operation-failed",
        "operation-uncertain",
      ]) &&
      JSON.stringify(smokeContract.evidenceAllowlist) === JSON.stringify([
        "namespace", "executionSha", "generation", "identity",
        "payloadSha256", "counts", "checks", "requestIds",
      ]) &&
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
    contract.vercelDeploymentAdapterStatus === "live-rest-contract-gated" &&
      contract.stagedProductionSafetyStatus === "verified-auto-assign-disabled" &&
      typeof adapterModule.buildCreateVercelDeploymentRequest === "function" &&
      typeof adapterModule.buildPromoteVercelDeploymentRequest === "function" &&
      typeof adapterModule.buildRollbackVercelDeploymentRequest === "function" &&
      typeof adapterModule.parseReadyVercelProductionDeployment === "function",
    "Vercel REST request contract must remain explicit and protected",
  );
  let mutationDisabled = false;
  try {
    adapterModule.createVercelDeploymentRestAdapter();
  } catch (error) {
    mutationDisabled = error?.constructor?.name === "VercelDeploymentMutationDisabledError";
  }
  assertContract(mutationDisabled, "Vercel REST adapter must fail closed without an enabled runtime configuration");
  const disabledCreateArtifact =
    sourceManifestModule.canonicalizeProductionDeploymentSourceManifest({
      schemaVersion: 1,
      commitSha: "a".repeat(40),
      files: [],
    });
  let createDisabled = false;
  try {
    adapterModule.buildCreateVercelDeploymentRequest({
      projectId: contract.vercelProjectId,
      projectName: contract.vercelProjectName,
      releaseIdentity: `production:${"a".repeat(40)}`,
      sourceManifestArtifact: disabledCreateArtifact,
      stagedProductionSafetyVerified: false,
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
    contract.productionDeploymentStatus === "ready-protected-rest-release" &&
      contract.productionSmokePrincipalStatus === "verified" &&
      contract.productionCustomDomain === "gamebase.elek.li" &&
      contract.productionDeploymentEnabled === true,
    "Production application deployment must pin every verified external prerequisite",
  );
  assertContract(
    JSON.stringify(contract.productionDeploymentRequiredSecrets) ===
      JSON.stringify([
        "VERCEL_TOKEN",
        "PRODUCTION_MIGRATION_DATABASE_URL",
        "PRODUCTION_MIGRATION_CA_CERT",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET",
        "PRODUCTION_SMOKE_OWNER_ACCESS_JWT",
      ]) &&
      JSON.stringify(contract.productionDeploymentRequiredVariables) ===
        JSON.stringify([
          "VERCEL_ORG_ID",
          "VERCEL_PROJECT_ID",
          "PRODUCTION_CUSTOM_DOMAIN",
          "PRODUCTION_SMOKE_SUPABASE_URL",
          "PRODUCTION_SMOKE_SUPABASE_PUBLISHABLE_KEY",
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
      "850c9a9830611364d82d673ab2408b25fbff5573963cb77569e82bd010c84a1b" &&
      createHash("sha256").update(deploymentEvidenceSchemaText).digest("hex") ===
        contract.productionDeploymentEvidenceSchemaSha256,
    "Production deployment evidence schema fingerprint does not match the approved redaction boundary",
  );
  assertContract(
    productionApplicationWorkflow.includes("verify-release-candidate:") &&
      productionApplicationWorkflow.includes("environment:\n      name: Production") &&
      !productionApplicationWorkflow.slice(
        0,
        productionApplicationWorkflow.indexOf("release-production-application:"),
      ).includes("secrets.") &&
      productionApplicationWorkflow.includes("pnpm release:application:run") &&
      productionApplicationWorkflow.includes("pnpm release:migration:verify") &&
      productionApplicationWorkflow.includes("group: production-release") &&
      !VERCEL_CLI_MUTATION.test(productionApplicationWorkflow),
    "Production application workflow must keep candidate verification secret-free and mutation protected",
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
        JSON.stringify(["checks", "counts", "generation", "outcome", "requestIds"]) &&
      JSON.stringify(smokeSchema.required) ===
        JSON.stringify(["outcome", "generation", "requestIds"]) &&
      (evidenceProperties.canaryContractVersion as { const?: unknown } | undefined)?.const === 3,
    "Production smoke evidence must reject payloads and unknown fields",
  );
  const smokeGeneration = smokeSchema?.properties?.generation as JsonSchema | undefined;
  assertContract(
    smokeGeneration?.pattern ===
      "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    "Production smoke evidence must bind one UUIDv4 generation to the attempt",
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
    productionReleaseDoc.includes("productionDeploymentEnabled: true") &&
      productionReleaseDoc.includes(contract.productionDeploymentWriter) &&
      productionReleaseDoc.includes(contract.productionDeploymentEvidenceSchema) &&
      productionReleaseDoc.includes("資料庫 schema 永不隨 application rollback 回滾") &&
      productionReleaseDoc.includes("Promotion 與 rollback 各最多 2 次"),
    "Production release documentation must preserve the enabled bounded deployment model",
  );
  assertContract(contract.hostedPreview === false, "Hosted Preview must remain disabled");
  assertContract(contract.vercelGitDeployment === false, "Vercel Git deployment must remain disabled");
  assertContract(
    rlsPolicyManifest.schema === "app_private" &&
      Array.isArray(rlsPolicyManifest.policies) &&
      rlsPolicyManifest.policies.some((policy) =>
        JSON.stringify(policy) === JSON.stringify({
          table: "production_smoke_canaries",
          name: "migrator_production_smoke_canaries_all",
          validFrom: "0015",
          validUntilExclusive: null,
          permissiveness: "PERMISSIVE",
          command: "ALL",
          roles: ["app_migrator"],
          using: "true",
          withCheck: "true",
        }),
      ),
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
    ciWorkflow.includes(
      "go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -ignore 'SC2129:'",
    ) &&
      ciWorkflow.includes("pnpm release:migrations:lint --baseline-ref origin/main") &&
      /fetch-depth:\s*0/.test(ciWorkflow),
    "CI must validate workflows and compare the destructive-migration baseline with trusted main history",
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

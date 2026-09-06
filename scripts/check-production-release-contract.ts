import { readFile } from "node:fs/promises";
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
  productionEnvironment: string;
  repository: string;
  supabaseProjectRef: string;
  supabaseRegion: string;
  vercelGitDeployment: boolean;
  vercelProjectId: string;
  vercelProjectName: string;
}>;

const CONTRACT_PATH = ".github/production-release-contract.json";
const RLS_POLICY_MANIFEST_PATH = ".github/production-rls-policy-manifest.json";
const WORKFLOW_PATH = ".github/workflows/production-release.yml";
const RUNNER_PATH = "scripts/production-migration-runner.ts";
const RELEASE_STATE_MACHINE_PATH = "scripts/production-migration-release.ts";

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ProductionReleaseContractError: ${message}`);
  }
}

export async function checkProductionReleaseContract(root: string) {
  const contract = JSON.parse(
    await readFile(path.join(root, CONTRACT_PATH), "utf8"),
  ) as ProductionReleaseContract;
  const vercelConfig = JSON.parse(
    await readFile(path.join(root, "vercel.json"), "utf8"),
  ) as { git?: { deploymentEnabled?: boolean } };
  const workflow = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
  const runner = await readFile(path.join(root, RUNNER_PATH), "utf8");
  const releaseStateMachine = await readFile(path.join(root, RELEASE_STATE_MACHINE_PATH), "utf8");
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
  assertContract(contract.supabaseProjectRef === "wbtyuvufhrhybquzwfip", "Supabase project ref does not match the Production binding");
  assertContract(contract.supabaseRegion === "ap-south-1", "Supabase region does not match the Production binding");
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

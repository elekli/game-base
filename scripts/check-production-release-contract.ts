import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

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
const WORKFLOW_PATH = ".github/workflows/production-release.yml";

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
  const ciWorkflowFilename = path.basename(contract.ciWorkflow);

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
    vercelConfig.git?.deploymentEnabled === false,
    "vercel.json must disable Git deployments",
  );
  assertContract(/^\s{4}environment:\n\s{6}name: Production$/m.test(workflow), "release job must use the protected Production environment");
  const trustedCheckout = workflow.indexOf("ref: main");
  const verification = workflow.indexOf("Verify exact main commit and successful CI");
  const candidateCheckout = workflow.indexOf('git checkout --detach "$COMMIT_SHA"');
  const repositoryScripts = workflow.indexOf("pnpm install --frozen-lockfile");
  assertContract(trustedCheckout >= 0, "workflow must check out trusted main first");
  assertContract(
    !workflow.includes("ref: ${{ inputs.commit_sha }}"),
    "workflow must not initially check out an unverified candidate",
  );
  assertContract(
    workflow.includes(
      `actions/workflows/${ciWorkflowFilename}/runs?head_sha=\${COMMIT_SHA}`,
    ),
    "release gate must query the configured CI workflow for the requested commit",
  );
  assertContract(/\.head_branch == "main"/.test(workflow), "release gate must require a main workflow run");
  assertContract(/\.event == "push"/.test(workflow), "release gate must require a push workflow run");
  assertContract(/\.conclusion == "success"/.test(workflow), "release gate must require a successful workflow run");
  assertContract(
    verification > trustedCheckout &&
      candidateCheckout > verification &&
      repositoryScripts > candidateCheckout,
    "candidate checkout and repository scripts must follow trust verification",
  );
  assertContract(!/vercel\s+(deploy|--prod)|supabase\s+db\s+(push|reset)/.test(workflow), "T01 gate must not deploy or mutate Production");

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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { deploymentBindings } from "../src/shared/config/deployment-bindings";
import {
  createVercelReadOnlyRestClient,
  type VercelReadOnlyRestClient,
} from "./vercel-read-only-rest-client";

export type LiveProductionSettings = Readonly<{
  githubDeploymentBranchPolicies: Array<{ name?: string }>;
  githubEnvironmentSecretNames: string[];
  supabaseApiKeyFingerprints: {
    publishable: string;
    secret: string;
  };
  githubProtection: {
    enforce_admins?: { enabled?: boolean };
    required_pull_request_reviews?: object | null;
    required_status_checks?: {
      checks?: Array<{ app_id?: number; context?: string }>;
      contexts?: string[];
    } | null;
  };
  githubEnvironment: {
    can_admins_bypass?: boolean;
    deployment_branch_policy?: {
      custom_branch_policies?: boolean;
      protected_branches?: boolean;
    } | null;
    name?: string;
    protection_rules?: Array<{ type?: string }>;
  };
  vercelEnvironmentVariables: Array<{
    id?: string;
    key?: string;
    target?: string[];
    type?: string;
    value?: string;
    valueSha256?: string;
  }>;
  vercelProject: {
    gitRepository?: object | null;
    id?: string;
    link?: object | null;
    name?: string;
  };
}>;

function assertSetting(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ProductionSettingError: ${message}`);
  }
}

export function checkLiveProductionSettings(settings: LiveProductionSettings) {
  const {
    githubEnvironment,
    githubProtection,
    supabaseApiKeyFingerprints,
    vercelEnvironmentVariables,
    vercelProject,
  } = settings;
  assertSetting(githubProtection.required_pull_request_reviews != null, "main must require pull requests");
  assertSetting(githubProtection.required_status_checks?.contexts?.includes("verify"), "main must require verify");
  assertSetting(
    githubProtection.required_status_checks?.checks?.some(
      (check) => check.context === "verify" && check.app_id === 15368,
    ),
    "main must bind verify to the GitHub Actions app",
  );
  assertSetting(githubProtection.enforce_admins?.enabled === true, "main protection must include administrators");
  assertSetting(githubEnvironment.name === "Production", "Production environment is missing");
  assertSetting(githubEnvironment.can_admins_bypass === false, "Production must disallow administrator bypass");
  assertSetting(githubEnvironment.protection_rules?.some((rule) => rule.type === "required_reviewers"), "Production must require a reviewer");
  assertSetting(
    githubEnvironment.deployment_branch_policy?.protected_branches === false &&
      githubEnvironment.deployment_branch_policy?.custom_branch_policies === true,
    "Production must use a custom branch allowlist",
  );
  assertSetting(
    settings.githubDeploymentBranchPolicies.length === 1 &&
      settings.githubDeploymentBranchPolicies[0]?.name === "main",
    "Production must allow only the main branch",
  );
  assertSetting(
    settings.githubEnvironmentSecretNames.includes(
      "PRODUCTION_MIGRATION_DATABASE_URL",
    ) &&
      settings.githubEnvironmentSecretNames.includes(
        "PRODUCTION_MIGRATION_CA_CERT",
      ),
    "Production migration TLS secrets are missing",
  );
  assertSetting(vercelProject.id === "prj_iTlWeDkcKItHTKYIayoNjQQ0vHec", "unexpected Vercel project ID");
  assertSetting(vercelProject.name === "game-base", "unexpected Vercel project name");
  assertSetting(vercelProject.gitRepository == null && vercelProject.link == null, "Vercel Git integration must be disconnected");
  assertSetting(vercelEnvironmentVariables.length > 0, "Vercel Production variables are missing");
  assertSetting(
    vercelEnvironmentVariables.every(
      (variable) =>
        variable.target?.length === 1 && variable.target[0] === "production",
    ),
    "Vercel variables must not target Preview or Development",
  );
  const requireVariable = (key: string, type: string) => {
    const variable = vercelEnvironmentVariables.find((candidate) => candidate.key === key);
    assertSetting(variable != null, `${key} is missing from Vercel Production`);
    assertSetting(variable.type === type, `${key} must use Vercel type ${type}`);
    return variable;
  };
  requireVariable("BGG_TOKEN", "sensitive");
  requireVariable("IGDB_CLIENT_ID", "encrypted");
  requireVariable("IGDB_CLIENT_SECRET", "sensitive");
  const publishableKey = requireVariable("SUPABASE_PUBLISHABLE_KEY", "encrypted");
  requireVariable("SUPABASE_SECRET_KEY", "sensitive");
  const expectedPublishableFingerprint = requireVariable(
    "EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256",
    "encrypted",
  );
  const expectedSecretFingerprint = requireVariable(
    "EXPECTED_SUPABASE_SECRET_KEY_SHA256",
    "encrypted",
  );
  const requireBindingValue = (key: string, expected: string) => {
    const variable = requireVariable(key, "encrypted");
    assertSetting(
      variable.value === expected,
      `${key} does not match the Production binding`,
    );
  };
  requireBindingValue("SUPABASE_PROJECT_REF", deploymentBindings.production.projectRef);
  requireBindingValue(
    "EXPECTED_SUPABASE_PROJECT_REF",
    deploymentBindings.production.projectRef,
  );
  const supabaseUrl = requireVariable("SUPABASE_URL", "encrypted").value;
  let supabaseHostname: string | undefined;
  try {
    supabaseHostname = typeof supabaseUrl === "string" ? new URL(supabaseUrl).hostname : undefined;
  } catch {
    supabaseHostname = undefined;
  }
  assertSetting(
    supabaseHostname === deploymentBindings.production.supabaseHostname,
    "SUPABASE_URL does not match the Production binding",
  );
  requireBindingValue("SUPAVISOR_HOST", deploymentBindings.production.supavisorHost);
  requireBindingValue(
    "EXPECTED_SUPAVISOR_HOST",
    deploymentBindings.production.supavisorHost,
  );
  requireBindingValue("SUPAVISOR_PORT", String(deploymentBindings.production.supavisorPort));
  requireBindingValue(
    "SUPAVISOR_USERNAME",
    deploymentBindings.production.supavisorUsername,
  );
  requireBindingValue(
    "EXPECTED_SUPAVISOR_USERNAME",
    deploymentBindings.production.supavisorUsername,
  );
  assertSetting(
    publishableKey.valueSha256 === deploymentBindings.production.publishableKeySha256,
    "SUPABASE_PUBLISHABLE_KEY fingerprint does not match the Production binding",
  );
  assertSetting(
    expectedPublishableFingerprint.value === deploymentBindings.production.publishableKeySha256,
    "publishable key fingerprint variable does not match the Production binding",
  );
  assertSetting(
    expectedSecretFingerprint.value === deploymentBindings.production.secretKeySha256,
    "secret key fingerprint variable does not match the Production binding",
  );
  assertSetting(
    supabaseApiKeyFingerprints.publishable ===
      deploymentBindings.production.publishableKeySha256,
    "current Supabase publishable key does not match the Production binding",
  );
  assertSetting(
    supabaseApiKeyFingerprints.secret === deploymentBindings.production.secretKeySha256,
    "current Supabase secret key does not match the Production binding",
  );

  return {
    githubEnvironment: githubEnvironment.name,
    productionMigrationTlsSecretsPresent: true,
    productionSourceCredentialsPresent: true,
    requiredCheck: "verify",
    vercelEnvironmentVariableCount: vercelEnvironmentVariables.length,
    vercelGitConnected: false,
  };
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8" },
) => string | Buffer;

export class ProductionSettingsCommandError extends Error {
  constructor() {
    super("無法安全讀取 production 設定。");
    this.name = "ProductionSettingsCommandError";
  }
}

export function readJsonSafely(
  command: string,
  args: string[],
  runner: CommandRunner = execFileSync,
) {
  try {
    const output = runner(command, args, { encoding: "utf8" });
    return JSON.parse(String(output));
  } catch {
    throw new ProductionSettingsCommandError();
  }
}

const VERCEL_PROJECT_ID = "prj_iTlWeDkcKItHTKYIayoNjQQ0vHec";
const VERCEL_TEAM_ID = "team_vpaufHhAabxSup7QLCbCGwlF";

export async function readLiveSettings({
  commandRunner = execFileSync,
  vercelClient,
}: Readonly<{
  commandRunner?: CommandRunner;
  vercelClient: VercelReadOnlyRestClient;
}>): Promise<LiveProductionSettings> {
  const vercelEnvironmentVariables =
    await vercelClient.listProjectEnvironmentVariables(VERCEL_PROJECT_ID);
  const readVariableValue = async (key: string) => {
    const variable = vercelEnvironmentVariables.find(
      (candidate) => candidate.key === key,
    );
    assertSetting(variable?.id != null, `${key} is missing from Vercel Production`);
    const detail = await vercelClient.getProjectEnvironmentVariable(
      VERCEL_PROJECT_ID,
      variable.id,
    );
    assertSetting(
      typeof detail.value === "string",
      `${key} cannot be read safely from Vercel`,
    );
    return detail.value;
  };
  const readableVariableKeys = [
    "EXPECTED_SUPABASE_PROJECT_REF",
    "EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256",
    "EXPECTED_SUPABASE_SECRET_KEY_SHA256",
    "EXPECTED_SUPAVISOR_HOST",
    "EXPECTED_SUPAVISOR_USERNAME",
    "SUPABASE_PROJECT_REF",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
    "SUPAVISOR_HOST",
    "SUPAVISOR_PORT",
    "SUPAVISOR_USERNAME",
  ] as const;
  const readableValues = new Map(
    await Promise.all(
      readableVariableKeys.map(
        async (key) => [key, await readVariableValue(key)] as const,
      ),
    ),
  );
  const publishableKey = readableValues.get("SUPABASE_PUBLISHABLE_KEY")!;
  const supabaseApiKeys = readJsonSafely(
    "pnpm",
    [
      "exec",
      "supabase",
      "projects",
      "api-keys",
      "--project-ref",
      deploymentBindings.production.projectRef,
      "--output",
      "json",
    ],
    commandRunner,
  ) as Array<{ api_key?: string; type?: string }>;
  const fingerprintSupabaseKey = (prefix: "sb_publishable_" | "sb_secret_") => {
    const value = supabaseApiKeys.find((key) => key.api_key?.startsWith(prefix))?.api_key;
    assertSetting(typeof value === "string", `current ${prefix} key is unavailable`);
    return createHash("sha256").update(value).digest("hex");
  };
  return {
    githubDeploymentBranchPolicies: (
      readJsonSafely(
        "gh",
        [
          "api",
          "repos/elekli/game-base/environments/Production/deployment-branch-policies",
        ],
        commandRunner,
      ) as { branch_policies?: Array<{ name?: string }> }
    ).branch_policies ?? [],
    githubEnvironmentSecretNames: (
      readJsonSafely(
        "gh",
        ["api", "repos/elekli/game-base/environments/Production/secrets"],
        commandRunner,
      ) as { secrets?: Array<{ name?: string }> }
    ).secrets?.flatMap((secret) => (secret.name ? [secret.name] : [])) ?? [],
    supabaseApiKeyFingerprints: {
      publishable: fingerprintSupabaseKey("sb_publishable_"),
      secret: fingerprintSupabaseKey("sb_secret_"),
    },
    githubProtection: readJsonSafely(
      "gh",
      ["api", "repos/elekli/game-base/branches/main/protection"],
      commandRunner,
    ),
    githubEnvironment: readJsonSafely(
      "gh",
      ["api", "repos/elekli/game-base/environments/Production"],
      commandRunner,
    ),
    vercelProject: await vercelClient.getProject(VERCEL_PROJECT_ID),
    vercelEnvironmentVariables: vercelEnvironmentVariables.map(({ key, target, type }) => ({
      key,
      target,
      type,
      value: readableValues.get(key as (typeof readableVariableKeys)[number]),
      valueSha256:
        key === "SUPABASE_PUBLISHABLE_KEY"
          ? createHash("sha256").update(publishableKey).digest("hex")
          : undefined,
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertSetting(process.argv.includes("--live"), "pass --live to query GitHub and Vercel");
  const result = checkLiveProductionSettings(
    await readLiveSettings({
      vercelClient: createVercelReadOnlyRestClient({
        teamId: VERCEL_TEAM_ID,
        timeoutMs: 10_000,
        token: process.env.VERCEL_TOKEN ?? "",
      }),
    }),
  );
  console.log(JSON.stringify({ event: "live_production_settings_validated", ...result }));
}

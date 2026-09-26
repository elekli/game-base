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
    publishable: string[];
    secret: string[];
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
    autoAssignCustomDomains?: boolean;
    gitRepository?: object | null;
    id?: string;
    link?: object | null;
    name?: string;
  };
  vercelProjectDomains: Array<{ name?: string; verified?: boolean }>;
}>;

function assertSetting(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ProductionSettingError: ${message}`);
  }
}

export function checkLiveProductionSettings(settings: LiveProductionSettings, hostedOnly = false) {
  const {
    githubEnvironment,
    githubProtection,
    supabaseApiKeyFingerprints,
    vercelEnvironmentVariables,
    vercelProject,
  } = settings;
  if (!hostedOnly) {
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
      settings.githubEnvironmentSecretNames.includes("PRODUCTION_MIGRATION_DATABASE_URL") &&
        settings.githubEnvironmentSecretNames.includes("PRODUCTION_MIGRATION_CA_CERT"),
      "Production migration TLS secrets are missing",
    );
    assertSetting(
      settings.githubEnvironmentSecretNames.includes("SUPABASE_ACCESS_TOKEN"),
      "Production Supabase management token is missing",
    );
  }
  assertSetting(vercelProject.id === "prj_iTlWeDkcKItHTKYIayoNjQQ0vHec", "unexpected Vercel project ID");
  assertSetting(vercelProject.name === "game-base", "unexpected Vercel project name");
  assertSetting(vercelProject.gitRepository == null && vercelProject.link == null, "Vercel Git integration must be disconnected");
  assertSetting(
    vercelProject.autoAssignCustomDomains === false,
    "Vercel automatic Custom Production Domain assignment must be disabled",
  );
  assertSetting(
    settings.vercelProjectDomains.some(
      (domain) =>
        domain.name === "gamebase.elek.li" && domain.verified === true,
    ),
    "gamebase.elek.li must be a verified Vercel project domain",
  );
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
    supabaseApiKeyFingerprints.publishable.includes(
      deploymentBindings.production.publishableKeySha256,
    ),
    "current Supabase publishable key does not match the Production binding",
  );
  assertSetting(
    supabaseApiKeyFingerprints.secret.includes(deploymentBindings.production.secretKeySha256),
    "current Supabase secret key does not match the Production binding",
  );

  return {
    githubEnvironment: hostedOnly ? undefined : githubEnvironment.name,
    productionMigrationTlsSecretsPresent: hostedOnly ? undefined : true,
    productionSourceCredentialsPresent: true,
    productionCustomDomain: "gamebase.elek.li",
    requiredCheck: hostedOnly ? undefined : "verify",
    vercelEnvironmentVariableCount: vercelEnvironmentVariables.length,
    vercelGitConnected: false,
  };
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] },
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
    const output = runner(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  hostedOnly = false,
}: Readonly<{
  commandRunner?: CommandRunner;
  vercelClient: VercelReadOnlyRestClient;
  hostedOnly?: boolean;
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
  const supabaseApiKeyFingerprints = readJsonSafely(
    process.execPath,
    ["scripts/fingerprint-supabase-api-keys.mjs"],
    commandRunner,
  ) as { publishable?: unknown; secret?: unknown };
  assertSetting(
    Array.isArray(supabaseApiKeyFingerprints.publishable) &&
      supabaseApiKeyFingerprints.publishable.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) &&
      Array.isArray(supabaseApiKeyFingerprints.secret) &&
      supabaseApiKeyFingerprints.secret.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
    "Supabase API key fingerprints are invalid",
  );
  return {
    githubDeploymentBranchPolicies: hostedOnly ? [] : (
      readJsonSafely(
        "gh",
        [
          "api",
          "repos/elekli/game-base/environments/Production/deployment-branch-policies",
        ],
        commandRunner,
      ) as { branch_policies?: Array<{ name?: string }> }
    ).branch_policies ?? [],
    githubEnvironmentSecretNames: hostedOnly ? [] : (
      readJsonSafely(
        "gh",
        ["api", "repos/elekli/game-base/environments/Production/secrets"],
        commandRunner,
      ) as { secrets?: Array<{ name?: string }> }
    ).secrets?.flatMap((secret) => (secret.name ? [secret.name] : [])) ?? [],
    supabaseApiKeyFingerprints: {
      publishable: supabaseApiKeyFingerprints.publishable,
      secret: supabaseApiKeyFingerprints.secret,
    },
    githubProtection: hostedOnly ? {} : readJsonSafely(
      "gh",
      ["api", "repos/elekli/game-base/branches/main/protection"],
      commandRunner,
    ),
    githubEnvironment: hostedOnly ? {} : readJsonSafely(
      "gh",
      ["api", "repos/elekli/game-base/environments/Production"],
      commandRunner,
    ),
    vercelProject: await vercelClient.getProject(VERCEL_PROJECT_ID),
    vercelProjectDomains:
      await vercelClient.listProjectDomains(VERCEL_PROJECT_ID),
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
  const hostedOnly = process.argv.includes("--hosted-only");
  if (hostedOnly) assertSetting(Boolean(process.env.SUPABASE_ACCESS_TOKEN), "Supabase management token is missing");
  const result = checkLiveProductionSettings(
    await readLiveSettings({
      hostedOnly,
      vercelClient: createVercelReadOnlyRestClient({
        teamId: VERCEL_TEAM_ID,
        timeoutMs: 10_000,
        token: process.env.VERCEL_TOKEN ?? "",
      }),
    }), hostedOnly,
  );
  console.log(JSON.stringify({ event: "live_production_settings_validated", ...result }));
}

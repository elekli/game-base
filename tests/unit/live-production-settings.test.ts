import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  checkLiveProductionSettings,
  readJsonSafely,
  readLiveSettings,
} from "../../scripts/check-live-production-settings";

const encrypted = (key: string, value: string) => ({
  key,
  target: ["production"],
  type: "encrypted",
  value,
});

const productionOnlySecret = (key: string, type: "encrypted" | "sensitive") => ({
  key,
  target: ["production"],
  type,
});

const validSettings = {
  githubDeploymentBranchPolicies: [{ name: "main" }],
  githubEnvironmentSecretNames: [
    "PRODUCTION_MIGRATION_CA_CERT",
    "PRODUCTION_MIGRATION_DATABASE_URL",
  ],
  supabaseApiKeyFingerprints: {
    publishable:
      "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
    secret: "d44eabeca41cb395b0d615673cc6ba17d762beb16d55380aecf539a551ed93b2",
  },
  githubProtection: {
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {},
    required_status_checks: {
      checks: [{ app_id: 15368, context: "verify" }],
      contexts: ["verify"],
    },
  },
  githubEnvironment: {
    can_admins_bypass: false,
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
    name: "Production",
    protection_rules: [{ type: "required_reviewers" }],
  },
  vercelEnvironmentVariables: [
    productionOnlySecret("BGG_TOKEN", "sensitive"),
    productionOnlySecret("IGDB_CLIENT_ID", "encrypted"),
    productionOnlySecret("IGDB_CLIENT_SECRET", "sensitive"),
    {
      key: "SUPABASE_PUBLISHABLE_KEY",
      target: ["production"],
      type: "encrypted",
      valueSha256:
        "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
    },
    encrypted("SUPABASE_PROJECT_REF", "wbtyuvufhrhybquzwfip"),
    encrypted("EXPECTED_SUPABASE_PROJECT_REF", "wbtyuvufhrhybquzwfip"),
    encrypted("SUPABASE_URL", "https://wbtyuvufhrhybquzwfip.supabase.co"),
    encrypted("SUPAVISOR_HOST", "aws-0-ap-south-1.pooler.supabase.com"),
    encrypted("EXPECTED_SUPAVISOR_HOST", "aws-0-ap-south-1.pooler.supabase.com"),
    encrypted("SUPAVISOR_PORT", "6543"),
    encrypted("SUPAVISOR_USERNAME", "app_runtime.wbtyuvufhrhybquzwfip"),
    encrypted(
      "EXPECTED_SUPAVISOR_USERNAME",
      "app_runtime.wbtyuvufhrhybquzwfip",
    ),
    { key: "SUPABASE_SECRET_KEY", target: ["production"], type: "sensitive" },
    {
      key: "EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256",
      target: ["production"],
      type: "encrypted",
      value: "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
    },
    {
      key: "EXPECTED_SUPABASE_SECRET_KEY_SHA256",
      target: ["production"],
      type: "encrypted",
      value: "d44eabeca41cb395b0d615673cc6ba17d762beb16d55380aecf539a551ed93b2",
    },
  ],
  vercelProject: {
    gitRepository: null,
    id: "prj_iTlWeDkcKItHTKYIayoNjQQ0vHec",
    link: null,
    name: "game-base",
  },
};

describe("live production settings", () => {
  it("accepts PR-only GitHub protection and a disconnected Vercel project", () => {
    expect(checkLiveProductionSettings(validSettings)).toEqual({
      githubEnvironment: "Production",
      productionMigrationTlsSecretsPresent: true,
      productionSourceCredentialsPresent: true,
      requiredCheck: "verify",
      vercelEnvironmentVariableCount: 15,
      vercelGitConnected: false,
    });
  });

  it.each(["BGG_TOKEN", "IGDB_CLIENT_ID", "IGDB_CLIENT_SECRET"])(
    "rejects a missing %s source credential",
    (key) => {
      expect(() =>
        checkLiveProductionSettings({
          ...validSettings,
          vercelEnvironmentVariables: validSettings.vercelEnvironmentVariables.filter(
            (variable) => variable.key !== key,
          ),
        }),
      ).toThrow(`${key} is missing from Vercel Production`);
    },
  );

  it.each(["BGG_TOKEN", "IGDB_CLIENT_ID", "IGDB_CLIENT_SECRET"])(
    "rejects %s outside the Production-only target",
    (key) => {
      expect(() =>
        checkLiveProductionSettings({
          ...validSettings,
          vercelEnvironmentVariables: validSettings.vercelEnvironmentVariables.map(
            (variable) =>
              variable.key === key
                ? { ...variable, target: ["production", "preview"] }
                : variable,
          ),
        }),
      ).toThrow("Vercel variables must not target Preview or Development");
    },
  );

  it.each([
    ["BGG_TOKEN", "encrypted", "sensitive"],
    ["IGDB_CLIENT_ID", "sensitive", "encrypted"],
    ["IGDB_CLIENT_SECRET", "encrypted", "sensitive"],
  ])(
    "rejects %s when it uses Vercel type %s instead of %s",
    (key, actualType, expectedType) => {
      expect(() =>
        checkLiveProductionSettings({
          ...validSettings,
          vercelEnvironmentVariables: validSettings.vercelEnvironmentVariables.map(
            (variable) =>
              variable.key === key ? { ...variable, type: actualType } : variable,
          ),
        }),
      ).toThrow(`${key} must use Vercel type ${expectedType}`);
    },
  );

  it("rejects a production credential copied to Preview", () => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        vercelEnvironmentVariables: [
          {
            key: "SUPABASE_SECRET_KEY",
            target: ["production", "preview"],
            type: "sensitive",
          },
        ],
      }),
    ).toThrow("Vercel variables must not target Preview or Development");
  });

  it("rejects a missing Production migration connection secret", () => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        githubEnvironmentSecretNames: [],
      }),
    ).toThrow("Production migration TLS secrets are missing");
  });

  it("rejects verify checks owned by the wrong GitHub app", () => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        githubProtection: {
          ...validSettings.githubProtection,
          required_status_checks: {
            checks: [{ app_id: 1, context: "verify" }],
            contexts: ["verify"],
          },
        },
      }),
    ).toThrow("main must bind verify to the GitHub Actions app");
  });

  it("rejects verify checks without a GitHub app binding", () => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        githubProtection: {
          ...validSettings.githubProtection,
          required_status_checks: { checks: [], contexts: ["verify"] },
        },
      }),
    ).toThrow("main must bind verify to the GitHub Actions app");
  });

  it.each([
    [[{ name: "release" }]],
    [[{ name: "main" }, { name: "release" }]],
  ])("rejects a Production branch allowlist other than main only", (policies) => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        githubDeploymentBranchPolicies: policies,
      }),
    ).toThrow("Production must allow only the main branch");
  });

  it.each([
    ["SUPABASE_PROJECT_REF", "wrong-ref"],
    ["SUPABASE_URL", "https://wrong-ref.supabase.co"],
    ["SUPAVISOR_HOST", "wrong.pooler.supabase.com"],
    ["SUPAVISOR_PORT", "5432"],
    ["SUPAVISOR_USERNAME", "app_runtime.wrong-ref"],
  ])("rejects a mismatched %s binding", (key, value) => {
    expect(() =>
      checkLiveProductionSettings({
        ...validSettings,
        vercelEnvironmentVariables: validSettings.vercelEnvironmentVariables.map(
          (variable) => (variable.key === key ? { ...variable, value } : variable),
        ),
      }),
    ).toThrow("does not match the Production binding");
  });

  it("drops secret subprocess output when a command fails", () => {
    const secret = "sb_secret_must_never_escape";
    let thrown: unknown;
    try {
      readJsonSafely("supabase", ["projects", "api-keys"], () => {
        throw Object.assign(new Error("command failed"), {
          stderr: Buffer.from(secret),
          stdout: Buffer.from(secret),
        });
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("無法安全讀取 production 設定。");
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it("reads Vercel through REST while retaining the GitHub and Supabase command runner", async () => {
    const publishable = "sb_publishable_fixture";
    const secret = "sb_secret_fixture";
    const commandRunner = vi.fn((command: string, args: string[]) => {
      if (command === "pnpm") {
        return JSON.stringify([
          { api_key: publishable, type: "publishable" },
          { api_key: secret, type: "secret" },
        ]);
      }
      if (args.at(-1)?.endsWith("deployment-branch-policies")) {
        return JSON.stringify({ branch_policies: [{ name: "main" }] });
      }
      if (args.at(-1)?.endsWith("/secrets")) {
        return JSON.stringify({
          secrets: [{ name: "PRODUCTION_MIGRATION_DATABASE_URL" }],
        });
      }
      if (args.at(-1)?.endsWith("/protection")) {
        return JSON.stringify({ required_pull_request_reviews: {} });
      }
      return JSON.stringify({ name: "Production" });
    });
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
    ];
    const environmentVariables = readableVariableKeys.map((key) => ({
      id: `${key}-id`,
      key,
      target: ["production"],
      type: "encrypted",
    }));
    const vercelClient = {
      getProject: vi.fn(async () => ({
        gitRepository: null,
        id: "project-id",
        link: null,
        name: "game-base",
      })),
      getProjectEnvironmentVariable: vi.fn(
        async (_projectId: string, variableId: string) => ({
          value:
            variableId === "SUPABASE_PUBLISHABLE_KEY-id"
              ? publishable
              : variableId === "SUPABASE_PROJECT_REF-id"
                ? "wbtyuvufhrhybquzwfip"
                : `fixture-${variableId}`,
        }),
      ),
      listProjectEnvironmentVariables: vi.fn(async () => environmentVariables),
    };

    const settings = await readLiveSettings({ commandRunner, vercelClient });

    expect(
      commandRunner.mock.calls.map(([command]) => command),
    ).not.toContain("vercel");
    expect(commandRunner.mock.calls.map(([command]) => command)).toContain("gh");
    expect(commandRunner.mock.calls.map(([command]) => command)).toContain("pnpm");
    expect(vercelClient.listProjectEnvironmentVariables).toHaveBeenCalledOnce();
    expect(vercelClient.getProjectEnvironmentVariable).toHaveBeenCalledTimes(11);
    expect(vercelClient.getProject).toHaveBeenCalledOnce();
    expect(settings.vercelEnvironmentVariables).toContainEqual({
      key: "SUPABASE_PUBLISHABLE_KEY",
      target: ["production"],
      type: "encrypted",
      value: publishable,
      valueSha256: createHash("sha256").update(publishable).digest("hex"),
    });
    expect(settings.vercelEnvironmentVariables).toContainEqual({
      key: "SUPABASE_PROJECT_REF",
      target: ["production"],
      type: "encrypted",
      value: "wbtyuvufhrhybquzwfip",
      valueSha256: undefined,
    });
  });
});

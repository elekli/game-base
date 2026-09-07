import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoVercelDeploymentMutationEntrypoints,
  checkProductionReleaseContract,
  readRepositoryExecutableSources,
} from "../../scripts/check-production-release-contract";

describe("production release contract", () => {
  it("pins the disabled application deployment writer and evidence boundary", async () => {
    const contract = JSON.parse(
      await readFile(".github/production-release-contract.json", "utf8"),
    ) as Record<string, unknown>;
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const evidenceSchema = JSON.parse(
      await readFile(
        ".github/production-deployment-evidence.schema.json",
        "utf8",
      ),
    ) as {
      additionalProperties?: unknown;
      required?: unknown;
      properties: {
        smoke: {
          properties: {
            requestIds: unknown;
          };
        };
        [key: string]: unknown;
      };
      allOf: Array<{
        then?: {
          properties?: {
            rollbackAttempts?: { minimum?: number };
            smoke?: {
              properties?: {
                counts?: {
                  required?: string[];
                  properties?: { cleanup?: { $ref?: string } };
                };
                checks?: {
                  required?: string[];
                  properties?: {
                    "canary-cleanup-counts"?: { const?: string };
                  };
                };
              };
            };
          };
        };
      }>;
    };
    const sourceManifestSchema = JSON.parse(
      await readFile(
        ".github/production-deployment-source-manifest.schema.json",
        "utf8",
      ),
    ) as {
      maxItems?: number;
      "x-maxCanonicalUtf8Bytes"?: number;
      properties?: {
        files?: {
          maxItems?: number;
          "x-maxTotalBytes"?: number;
          items?: {
            properties?: {
              path?: { maxLength?: number; "x-maxUtf8Bytes"?: number };
              size?: { maximum?: number };
            };
          };
        };
      };
    };
    const vercelSettingsReadAdapter = await readFile(
      "scripts/vercel-read-only-rest-client.ts",
      "utf8",
    );
    const liveSettingsChecker = await readFile(
      "scripts/check-live-production-settings.ts",
      "utf8",
    );

    expect(contract).toMatchObject({
      vercelTeamId: "team_vpaufHhAabxSup7QLCbCGwlF",
      vercelDeploymentCliCandidateVersion: "59.11.7",
      vercelDeploymentCliStatus: "blocked-security-audit",
      vercelDeploymentAdapterEvaluation:
        ".github/vercel-deployment-adapter-evaluation.json",
      vercelSettingsReadAdapter: "scripts/vercel-read-only-rest-client.ts",
      vercelSettingsReadStatus: "ready-official-rest-read-only",
      productionDeploymentWriter:
        ".github/workflows/production-application-release.yml",
      productionDeploymentModel: "scripts/production-deployment-release.ts",
      productionDeploymentStatus:
        "blocked-external-prerequisites-and-staging-safety-verification",
      vercelDeploymentAdapter: "scripts/vercel-deployment-rest-adapter.ts",
      vercelDeploymentAdapterStatus:
        "request-contract-ready-live-mutations-disabled",
      stagedProductionSafetyStatus: "auto-assign-disablement-unverified",
      vercelRestTransport: "scripts/vercel-rest-transport.ts",
      vercelRestTransportSha256:
        "66828fd2876a4186e876cfe60a22700ab52457031ee7238513bf4fe7c622e5e6",
      productionDeploymentSourceManifestBuilder:
        "scripts/production-deployment-source-manifest.ts",
      productionDeploymentSourceManifestSchema:
        ".github/production-deployment-source-manifest.schema.json",
      productionSmokeContract: ".github/production-smoke-contract.json",
      productionSmokeModel: "scripts/production-smoke-canary.ts",
      productionRestoreModel: "scripts/production-restore-drill.ts",
      productionRestoreEvidenceSchema:
        ".github/production-restore-drill-evidence.schema.json",
      productionSmokePrincipalStatus: "unresolved",
      productionCustomDomain: null,
      productionDeploymentEnabled: false,
      productionDeploymentRequiredSecrets: [
        "VERCEL_TOKEN",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET",
      ],
      productionDeploymentRequiredVariables: [
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID",
        "PRODUCTION_CUSTOM_DOMAIN",
      ],
      productionDeploymentEvidenceSchema:
        ".github/production-deployment-evidence.schema.json",
      productionDeploymentEvidenceSchemaSha256:
        "4c0a1f5fa6b1ddd54f090e66b24bf11d90b0a6fe1d87dd587d43c23e99a41f8b",
      productionDeploymentSourceManifestBuilderSha256:
        "2d6e5c5f805cf8a39ae186bebf63535bf128039d9b1b52ea6f478e879df90a67",
      productionDeploymentSourceManifestSchemaSha256:
        "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      vercelDeploymentAdapterSha256:
        "41525fdd1ee5ea1c92f65238821b2e28ec53cfa1e034aa6271e1a09ba50fb399",
      productionSmokeContractSha256:
        "30301fbfa2b15ca5a0e33a65fcb68998ce5bbf112e9499baca21ca1ef9b37166",
      productionSmokeModelSha256:
        "f2062c6830759da1bcf7799156c2231b348fad20f105f1a72851d01d838f7d84",
      productionRestoreModelSha256:
        "3352e9a3d4390a4df4ebc56b63c7f9a95c4323acc13b7fefa05c1383542a3aa4",
      productionRestoreEvidenceSchemaSha256:
        "b801b6e3e46f64c3e273c33b5c3c3432ebc152247900e125459f2cecc5613d40",
    });
    expect(packageJson.devDependencies).not.toHaveProperty("vercel");
    expect(Object.values(packageJson.scripts ?? {}).join("\n")).not.toMatch(
      /(?:pnpm\s+(?:dlx|exec)|npx)\s+vercel|\bvercel\s+(?:deploy|promote|rollback)\b/,
    );
    expect(packageJson.scripts?.["release:settings:check"]).toBe(
      "tsx scripts/check-live-production-settings.ts --live",
    );
    expect(vercelSettingsReadAdapter).not.toMatch(
      /method:\s*"(?:POST|PUT|PATCH|DELETE)"/,
    );
    expect(vercelSettingsReadAdapter).not.toMatch(
      /\/deployments|\/promote|\/rollback/,
    );
    expect(liveSettingsChecker).not.toMatch(
      /readJsonSafely\("vercel"|execFile(?:Sync)?\("vercel"/,
    );
    expect(evidenceSchema.additionalProperties).toBe(false);
    expect(evidenceSchema.required).toContain("executionSha");
    expect(evidenceSchema.required).toContain("baselineDeploymentId");
    expect(evidenceSchema.required).toContain("stagedDeploymentId");
    expect(evidenceSchema.required).toContain("releaseIdentity");
    expect(evidenceSchema.required).toContain("sourceManifestSha256");
    expect(evidenceSchema.properties.smoke.properties.requestIds).toEqual({
      type: "array",
      maxItems: 16,
      uniqueItems: true,
      items: {
        type: "string",
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      },
    });
    const rolledBackEvidence = evidenceSchema.allOf[1]?.then?.properties;
    expect(rolledBackEvidence?.rollbackAttempts?.minimum).toBe(0);
    expect(rolledBackEvidence?.smoke?.properties?.counts?.required).toEqual([
      "cleanup",
    ]);
    expect(
      rolledBackEvidence?.smoke?.properties?.counts?.properties?.cleanup?.$ref,
    ).toBe("#/$defs/zeroCounts");
    expect(rolledBackEvidence?.smoke?.properties?.checks?.required).toEqual([
      "canary-cleanup-counts",
    ]);
    expect(
      rolledBackEvidence?.smoke?.properties?.checks?.properties?.[
        "canary-cleanup-counts"
      ]?.const,
    ).toBe("passed");
    expect(evidenceSchema.required).toContain("canaryContractVersion");
    expect(evidenceSchema.properties).not.toHaveProperty("token");
    expect(evidenceSchema.properties).not.toHaveProperty("authorization");
    expect(evidenceSchema.properties).not.toHaveProperty("payload");
    expect(sourceManifestSchema.properties?.files).toMatchObject({
      maxItems: 20_000,
      "x-maxTotalBytes": 1024 * 1024 * 1024,
      items: {
        properties: {
          path: { maxLength: 1024, "x-maxUtf8Bytes": 1024 },
          size: { maximum: 50 * 1024 * 1024 },
        },
      },
    });
    expect(sourceManifestSchema["x-maxCanonicalUtf8Bytes"]).toBe(43_200_512);
    const passedEvidenceRule = (evidenceSchema as {
      allOf?: Array<{
        then?: {
          properties?: {
            smoke?: {
              properties?: {
                counts?: {
                  properties?: {
                    mutation?: {
                      properties?: Record<string, { const?: unknown }>;
                    };
                  };
                };
                checks?: {
                  properties?: Record<string, { const?: unknown }>;
                };
              };
            };
          };
        };
      }>;
    }).allOf?.[0]?.then?.properties?.smoke?.properties;
    expect(passedEvidenceRule?.counts?.properties?.mutation?.properties).toEqual({
      row: { const: 1 },
      object: { const: 1 },
    });
    expect(Object.values(passedEvidenceRule?.checks?.properties ?? {})).toHaveLength(8);
    expect(
      Object.values(passedEvidenceRule?.checks?.properties ?? {}).every(
        (check) => check.const === "passed",
      ),
    ).toBe(true);
  });

  it("rejects Vercel mutation entrypoints across dependencies, workflows, scripts, and package commands", () => {
    const clean = {
      packageJson: { scripts: { check: "tsx scripts/check.ts" } },
      scriptSources: { "check.ts": "export const readOnly = true;" },
      workflowSources: { "ci.yml": "run: pnpm test" },
    };
    expect(() =>
      assertNoVercelDeploymentMutationEntrypoints(clean),
    ).not.toThrow();
    expect(() =>
      assertNoVercelDeploymentMutationEntrypoints({
        ...clean,
        packageJson: { dependencies: { vercel: "1.0.0" } },
      }),
    ).toThrow(/dependency section/);
    expect(() =>
      assertNoVercelDeploymentMutationEntrypoints({
        ...clean,
        workflowSources: {
          "release.yml":
            "run: curl -X POST https://api.vercel.com/v13/deployments",
        },
      }),
    ).toThrow(/workflow release\.yml/);
    expect(() =>
      assertNoVercelDeploymentMutationEntrypoints({
        ...clean,
        scriptSources: {
          "deploy.ts":
            'import { buildCreateVercelDeploymentRequest } from "./vercel-deployment-rest-adapter";',
        },
      }),
    ).toThrow(/script deploy\.ts/);
    expect(() =>
      assertNoVercelDeploymentMutationEntrypoints({
        ...clean,
        packageJson: {
          scripts: {
            deploy: "tsx scripts/vercel-deployment-rest-adapter.ts",
          },
        },
      }),
    ).toThrow(/package scripts/);
    for (const [filename, source] of [
      ["src/deep/quiet.ts", 'const endpoint = "/v13/deployments";'],
      ["ops/release.sh", "vercel deploy --prod"],
      [".hidden/writer.py", 'requests.post("https://api.vercel.com/v13/deployments")'],
    ]) {
      expect(() =>
        assertNoVercelDeploymentMutationEntrypoints({
          ...clean,
          scriptSources: { [filename]: source },
        }),
      ).toThrow(new RegExp(filename.replace(/[.]/g, "\\.")));
    }
  });

  it("recursively reads executable sources while excluding generated trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-source-scan-"));
    try {
      await mkdir(join(root, "src", "deep"), { recursive: true });
      await mkdir(join(root, ".hidden"), { recursive: true });
      await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
      await writeFile(join(root, "src", "deep", "writer.ts"), "writer");
      await writeFile(join(root, ".hidden", "writer.py"), "writer");
      await writeFile(join(root, "run.sh"), "writer");
      await writeFile(join(root, "node_modules", "ignored", "writer.ts"), "ignored");

      const sources = await readRepositoryExecutableSources(root);
      expect(Object.keys(sources).sort()).toEqual([
        ".hidden/writer.py",
        "run.sh",
        "src/deep/writer.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the disabled Supabase Git production mapping and sole schema writer", async () => {
    const contract = JSON.parse(
      await readFile(".github/production-release-contract.json", "utf8"),
    ) as Record<string, unknown>;

    expect(contract.supabaseGitProductionBranch).toBe(
      "production-deploy-disabled-use-github-actions",
    );
    expect(contract.productionSchemaWriter).toBe(
      ".github/workflows/production-release.yml",
    );
  });

  it("accepts the repository-owned no-preview release contract", async () => {
    await expect(checkProductionReleaseContract(process.cwd())).resolves.toEqual({
      ciCheck: "verify",
      ciWorkflow: ".github/workflows/ci.yml",
      productionEnvironment: "Production",
      productionBranch: "main",
      vercelGitDeployment: false,
    });
  });

  it("keeps the candidate untrusted until main ancestry and CI are verified", async () => {
    const workflow = await readFile(
      ".github/workflows/production-release.yml",
      "utf8",
    );
    const trustedCheckout = workflow.indexOf("ref: main");
    const verification = workflow.indexOf("Verify exact current main commit and successful CI");
    const candidateCheckout = workflow.indexOf('git checkout --detach "$EXECUTION_SHA"');
    const repositoryScripts = workflow.indexOf("pnpm install --frozen-lockfile");
    const migrationOrchestrator = workflow.indexOf("pnpm release:migration:run");

    expect(trustedCheckout).toBeGreaterThan(-1);
    expect(verification).toBeGreaterThan(trustedCheckout);
    expect(candidateCheckout).toBeGreaterThan(verification);
    expect(repositoryScripts).toBeGreaterThan(candidateCheckout);
    expect(migrationOrchestrator).toBeGreaterThan(repositoryScripts);
  });

  it("keeps Production mutation behind approval and forbids destructive shortcuts", async () => {
    const workflow = await readFile(
      ".github/workflows/production-release.yml",
      "utf8",
    );
    const verifyJob = workflow.indexOf("verify-release-candidate:");
    const mutationJob = workflow.indexOf("mutate-production:");
    const mutationSteps = workflow.indexOf("    steps:", mutationJob);
    const tempPathSetup = workflow.indexOf("Configure release temp paths", mutationSteps);
    const packageManagerSetup = workflow.indexOf("- uses: pnpm/action-setup@v4", tempPathSetup);
    const mutationCheckout = workflow.indexOf("- uses: actions/checkout@v4", mutationSteps);
    const pinnedExecutionCheck = workflow.indexOf("Confirm pinned execution is still current main", mutationCheckout);
    const environment = workflow.indexOf("environment:\n      name: Production");
    const orchestrator = workflow.indexOf("Apply and strict-verify exact migration suffix");
    const authorization = workflow.indexOf("Authorize exact migration attempt");
    const records = workflow.indexOf("Create sanitized evidence and ledger");
    const persistedPlan = workflow.indexOf("Persist exact migration plan");
    const planArtifact = workflow.indexOf("production-migration-plan-${{ github.run_id }}-${{ github.run_attempt }}");
    const evidence = workflow.indexOf("production-migration-evidence");

    expect(mutationJob).toBeGreaterThan(verifyJob);
    expect(environment).toBeGreaterThan(mutationJob);
    expect(workflow.slice(mutationJob, mutationSteps)).not.toContain("runner.temp");
    expect(workflow.slice(mutationCheckout, tempPathSetup)).toContain("ref: ${{ needs.verify-release-candidate.outputs.execution_sha }}");
    expect(workflow.slice(mutationCheckout, tempPathSetup)).not.toContain("ref: main");
    expect(pinnedExecutionCheck).toBeGreaterThan(mutationCheckout);
    expect(workflow.slice(pinnedExecutionCheck, tempPathSetup)).toContain('test "$(git rev-parse HEAD)" = "$EXECUTION_SHA"');
    expect(workflow.slice(pinnedExecutionCheck, tempPathSetup)).toContain('test "$(git rev-parse origin/main)" = "$EXECUTION_SHA"');
    expect(workflow.slice(mutationCheckout, tempPathSetup)).not.toContain("secrets.");
    expect(tempPathSetup).toBeGreaterThan(mutationSteps);
    expect(packageManagerSetup).toBeGreaterThan(tempPathSetup);
    expect(workflow.slice(tempPathSetup, packageManagerSetup)).not.toContain("secrets.");
    expect(workflow).toContain('echo "RELEASE_PLAN_PATH=$RUNNER_TEMP/preflight.json" >> "$GITHUB_ENV"');
    expect(workflow).toContain('test "$execution_sha" = "$COMMIT_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$source_sha" "$execution_sha"');
    expect(workflow).toContain("head_sha=${execution_sha}");
    expect(workflow).toContain("CANDIDATE_SHA: ${{ needs.verify-release-candidate.outputs.candidate_sha }}");
    expect(workflow).toContain("SOURCE_SHA: ${{ needs.verify-release-candidate.outputs.source_sha }}");
    expect(orchestrator).toBeGreaterThan(environment);
    expect(planArtifact).toBeGreaterThan(persistedPlan);
    expect(authorization).toBeGreaterThan(planArtifact);
    expect(orchestrator).toBeGreaterThan(authorization);
    expect(workflow.slice(authorization, orchestrator)).not.toContain("PRODUCTION_MIGRATION_DATABASE_URL");
    expect(records).toBeGreaterThan(orchestrator);
    expect(evidence).toBeGreaterThan(records);
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("ledger-recovery");
    expect(workflow).not.toContain('> "$RUNNER_TEMP/preflight');
    expect(workflow).not.toMatch(/pnpm release:migration:(?:plan|run) --(?:\s|$)/);
    expect(workflow).toContain("umask 077");
    expect(workflow).toContain('echo "PGSSLROOTCERT=$cert"');
    expect(workflow.match(/- name: Apply and strict-verify exact migration suffix/g)).toHaveLength(1);
    expect(workflow).toContain("inputs.mode == 'apply' && 'record' || 'recovery'");
    expect(workflow).not.toContain("if: always()");
    expect(workflow).not.toContain("supabase migration up");
    expect(workflow).not.toMatch(
      /vercel\s+(?:deploy|--prod)|supabase\s+(?:db\s+(?:reset|push)|migration\s+repair)/,
    );
  });
});

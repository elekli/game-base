import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertNoVercelDeploymentMutationEntrypoints,
  assertReleaseSmokeAuthArtifactsPinned,
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
          required?: string[];
          properties: {
            generation: unknown;
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
      productionApplicationRunner: "scripts/production-application-release.ts",
      productionApplicationRunnerSha256:
        "6cbaa7e9bddcf9db00e5fc364c3625a097fa129a58d422081f90f2b87815add3",
      productionApplicationStateRunner:
        "scripts/production-application-release-runner.ts",
      productionApplicationStateRunnerSha256:
        "c329cc1605f0a9eda2d6df16d55a7c2eae6c698ea56373e7044cf88813589b07",
      productionDeploymentEvidenceWriter:
        "scripts/production-deployment-evidence.ts",
      productionDeploymentEvidenceWriterSha256:
        "749bcc8f8bc3a494b8b526c005d28ce5169da312b8e9a17e35694ef30f2155f4",
      productionDeploymentWriterSha256:
        "e7524b3fe9c020c2e7970301d90a849a08a6ec0ae81538d3ac2755e5c7d77746",
      productionDeploymentModel: "scripts/production-deployment-release.ts",
      productionDeploymentModelSha256:
        "e491156ff423e03872d95175236f86f3cde936b3254fe81d706e53776a96d093",
      productionDeploymentStatus:
        "ready-fail-closed-pending-external-prerequisites",
      vercelDeploymentAdapter: "scripts/vercel-deployment-rest-adapter.ts",
      vercelDeploymentAdapterStatus:
        "live-rest-contract-gated",
      stagedProductionSafetyStatus: "auto-assign-disablement-unverified",
      vercelRestTransport: "scripts/vercel-rest-transport.ts",
      vercelRestTransportSha256:
        "92569dcc9e85de5efe083da1ddf7951326ae3793ccfe535fda7024aedde139d4",
      productionDeploymentSourceManifestBuilder:
        "scripts/production-deployment-source-manifest.ts",
      productionDeploymentSourceManifestSchema:
        ".github/production-deployment-source-manifest.schema.json",
      productionSmokeContract: ".github/production-smoke-contract.json",
      releaseSmokeRoute: "src/app/api/internal/release-smoke/route.ts",
      releaseSmokeRouteSha256:
        "b2e22f7ffb8089ae408c201ef9da20ec5249ca4afc7256b74741bd232457486c",
      releaseSmokeHandler: "src/app/api/internal/release-smoke/handler.ts",
      releaseSmokeHandlerSha256:
        "bd090591c481088c9202b089ad5af2a4a8ce71b8282104fc4b3dd9329202ed98",
      releaseSmokeAccessTokenVerifier:
        "src/shared/auth/verify-release-smoke-access-token.ts",
      releaseSmokeAccessTokenVerifierSha256:
        "185701f85c21333153a6b8655df22dfd10545061ccd27e771033fe1196c8b767",
      releaseSmokeProductionAccessTokenVerifier:
        "src/shared/auth/production-release-smoke-access-token-verifier.ts",
      releaseSmokeProductionAccessTokenVerifierSha256:
        "2a1463331e350d5284f75ae7eb51ebbf7da74e0951b826a4e21130f2b4648b76",
      releaseSmokeDeploymentBindings:
        "src/shared/config/deployment-bindings.ts",
      releaseSmokeDeploymentBindingsSha256:
        "dd9041ce7ef885a4aab4cd555c418b84f9c1867dfc5849fd2510ae2398891948",
      productionSmokeModel: "scripts/production-smoke-canary.ts",
      productionSmokePersistenceMigration:
        "supabase/migrations/0015_production_smoke_canary.sql",
      productionSmokePersistenceMigrationSha256:
        "ecc8b4b53f319f877a3e5dc50d9690e1a36d94d5ee123d81d33a4eb1820687f8",
      productionSmokePersistencePgtap:
        "supabase/tests/0015_production_smoke_canary.pgtap.sql",
      productionSmokePersistencePgtapSha256:
        "f1cc8366f5dafa9b9aa28fa7334c9a2e4ffa555e6e62b7e0f09d7d31eb8998e3",
      productionSmokeRunnerStatus:
        "ready-fail-closed-pending-production-principal-and-live-credentials",
      productionSmokeAdapter:
        "src/adapters/production-smoke-canary-adapter.ts",
      productionSmokeAdapterSha256:
        "d976e4810f341690b3f8a236adb48f5c78a6a11660278e44da7fb316f30a53c6",
      productionSmokeRunnerSha256:
        "284f6531ecea8693f7b1c68ae3d8f5c76b84ecacd4f00a77daa3242d2de5e800",
      productionRestoreModel: "scripts/production-restore-drill.ts",
      productionRestoreExecutor: "scripts/production-restore-executor.ts",
      productionRestoreIntegrityChecker:
        "scripts/check-production-restore-integrity.ts",
      productionRestoreRunner: "scripts/production-restore.ts",
      productionRestoreWorkflow:
        ".github/workflows/production-restore-drill.yml",
      productionRestoreStatus: "ready-protected-manual",
      productionRestoreEvidenceSchema:
        ".github/production-restore-drill-evidence.schema.json",
      productionSmokePrincipalStatus: "unresolved",
      productionCustomDomain: null,
      productionDeploymentEnabled: false,
      productionDeploymentRequiredSecrets: [
        "VERCEL_TOKEN",
        "PRODUCTION_MIGRATION_DATABASE_URL",
        "PRODUCTION_MIGRATION_CA_CERT",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_ID",
        "PRODUCTION_SMOKE_CF_ACCESS_CLIENT_SECRET",
        "PRODUCTION_SMOKE_OWNER_ACCESS_JWT",
      ],
      productionDeploymentRequiredVariables: [
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID",
        "PRODUCTION_CUSTOM_DOMAIN",
        "PRODUCTION_SMOKE_SUPABASE_URL",
        "PRODUCTION_SMOKE_SUPABASE_PUBLISHABLE_KEY",
      ],
      productionDeploymentEvidenceSchema:
        ".github/production-deployment-evidence.schema.json",
      productionDeploymentEvidenceSchemaSha256:
        "850c9a9830611364d82d673ab2408b25fbff5573963cb77569e82bd010c84a1b",
      productionDeploymentSourceManifestBuilderSha256:
        "589afce50b16f0d4e6896ad091b9621a96065ad6f2a15c7d9c16d7e95ed1405a",
      productionDeploymentSourceManifestSchemaSha256:
        "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      vercelDeploymentAdapterSha256:
        "fcea0fd520df434b1c549e0d7b848530c60b43b87711814dae6f6ff3ffa464c3",
      productionSmokeContractSha256:
        "0086cb94455b9b75eb092bb20e7fb2343952b843f6ca9e6b46f29ab0d35d9199",
      productionSmokeModelSha256:
        "18fa525b8fdeac5430e70ca7164d42a55228e1b9b21981f92dffdac052ea4890",
      productionRestoreModelSha256:
        "96604eb799d32eefff62297efafe8e18cca595cc6d4505083f60ead85402f028",
      productionRestoreExecutorSha256:
        "6e19b32435954852b13fe1777d4d4a0aae8218242366ec2821fa894f5d1baeb2",
      productionRestoreIntegrityCheckerSha256:
        "60a12f3fa541ff0dbbc14ee0c954893648d4a6b01d1a3a67bd23faafa9b6ee28",
      productionRestoreRunnerSha256:
        "2ae2be12554e82d36220558a17ade62600c823a38efd72bbda8148d6ecbb7558",
      productionRestoreWorkflowSha256:
        "28cf4c2e32761df2692ef234c103944beb4b267512f577b1a5d3ccbb7c826974",
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
    expect(evidenceSchema.properties.canaryContractVersion).toEqual({ const: 3 });
    expect(evidenceSchema.properties.smoke.required).toEqual([
      "outcome",
      "generation",
      "requestIds",
    ]);
    expect(evidenceSchema.properties.smoke.properties.generation).toEqual({
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    });
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

  it.each([
    ["non-empty sub rejection", 'payload.sub !== ""', "false"],
    [
      "common_name fingerprint rejection",
      "!matchesSha256(payload.common_name, config.commonNameSha256)",
      "false",
    ],
  ])("rejects a verifier with tampered %s", async (_name, original, replacement) => {
    const root = await mkdtemp(join(tmpdir(), "release-smoke-auth-contract-"));
    try {
      const contract = JSON.parse(
        await readFile(".github/production-release-contract.json", "utf8"),
      ) as Parameters<typeof assertReleaseSmokeAuthArtifactsPinned>[1];
      const artifactPaths = [
        contract.releaseSmokeRoute,
        contract.releaseSmokeHandler,
        contract.releaseSmokeAccessTokenVerifier,
        contract.releaseSmokeProductionAccessTokenVerifier,
        contract.releaseSmokeDeploymentBindings,
      ];
      for (const artifactPath of artifactPaths) {
        const target = join(root, artifactPath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(artifactPath, "utf8"));
      }

      const verifierPath = join(root, contract.releaseSmokeAccessTokenVerifier);
      const verifier = await readFile(verifierPath, "utf8");
      expect(verifier).toContain(original);
      await writeFile(verifierPath, verifier.replace(original, replacement));

      await expect(
        assertReleaseSmokeAuthArtifactsPinned(root, contract),
      ).rejects.toThrow(/release-smoke access token verifier fingerprint/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("keeps application mutation behind exact-main, strict-schema, and Production gates", async () => {
    const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
    const workflow = await readFile(
      ".github/workflows/production-application-release.yml",
      "utf8",
    );
    const candidate = workflow.indexOf("verify-release-candidate:");
    const mutation = workflow.indexOf("release-production-application:");
    const mutationSteps = workflow.indexOf("    steps:", mutation);

    expect(candidate).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(candidate);
    expect(workflow.slice(0, mutation)).not.toContain("secrets.");
    expect(workflow.slice(mutation, mutationSteps)).toContain(
      "environment:\n      name: Production",
    );
    expect(workflow).toContain('test "$execution_sha" = "$COMMIT_SHA"');
    expect(workflow).toContain(
      'test "$(git rev-parse origin/main)" = "$EXECUTION_SHA"',
    );
    expect(workflow).toContain("pnpm release:migration:verify");
    expect(workflow).toContain("pnpm release:application:run");
    expect(workflow).toContain("production-application-evidence-");
    expect(workflow).toContain("retention-days: 90");
    expect(ciWorkflow).toContain(
      "go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -ignore 'SC2129:'",
    );
    expect(workflow).not.toMatch(
      /vercel\s+(?:deploy|--prod)|supabase\s+(?:db\s+(?:reset|push)|migration\s+repair)/,
    );
  });
});

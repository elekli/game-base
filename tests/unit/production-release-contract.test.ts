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
  it("pins the enabled application deployment writer and evidence boundary", async () => {
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
            failure: unknown;
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
              required?: string[];
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
        "d3b3be5b75a02d92c5be588720584ddf302c805343c50574a7dccb7e0929420d",
      productionOwnerSessionPreflight:
        "scripts/production-owner-session-preflight.ts",
      productionOwnerSessionPreflightSha256:
        "f02b710715d71d251d146a6a2ae5cdd9b1f57909a604a31b4202f4cc6c530e12",
      productionApplicationStateRunner:
        "scripts/production-application-release-runner.ts",
      productionApplicationStateRunnerSha256:
        "f3b2f014777e8d91157a4d649d0ca66eb9eef6bb2babdd50cc7db307e7ad933f",
      productionDeploymentEvidenceWriter:
        "scripts/production-deployment-evidence.ts",
      productionDeploymentEvidenceWriterSha256:
        "eead0cd0d62d9692df37cedcba7e513e6edafcc01b7c3b61e8dbc63e28d8e307",
      productionDeploymentWriterSha256:
        "e9aecd21e93451143e4fc0e9a6ad222908109e2fe1622703ddde550935c62cb5",
      productionSupabaseFingerprintHelper: "scripts/fingerprint-supabase-api-keys.mjs",
      productionSupabaseFingerprintHelperSha256:
        "e5046bdc858d1cd3777115d1e277d8995d2a594bc5c902ff13a15969154d0ba9",
      productionLiveSettingsChecker: "scripts/check-live-production-settings.ts",
      productionLiveSettingsCheckerSha256: "4abb9cf071fa261bc54e6facd1b2a43401d4be5d1ce67023a8d8d1089234e831",
      productionDeploymentModel: "scripts/production-deployment-release.ts",
      productionDeploymentModelSha256:
        "57138896b0f5b1881c22bfde6dbce440e4ec5b2a07c355e843aa4d85644b7b76",
      productionDeploymentStatus: "ready-protected-rest-release",
      vercelDeploymentAdapter: "scripts/vercel-deployment-rest-adapter.ts",
      vercelDeploymentAdapterStatus:
        "live-rest-contract-gated",
      stagedProductionSafetyStatus: "verified-auto-assign-disabled",
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
        "66d3bdee6562b98b3b65e411403a4f376b24c0c6954a2f5dcbbf35d2c1c1d79d",
      releaseSmokeHandler: "src/app/api/internal/release-smoke/handler.ts",
      releaseSmokeHandlerSha256:
        "8a793e07f82b2721b70539e93fd149311cf17a1ca8994163b75e84e731f6fb25",
      releaseSmokeAccessTokenVerifier:
        "src/shared/auth/verify-release-smoke-access-token.ts",
      releaseSmokeAccessTokenVerifierSha256:
        "8326464e6af23dfd1d1a0257055090f86bffb19b9f4ba333560f6ac5d893366b",
      releaseSmokeProductionAccessTokenVerifier:
        "src/shared/auth/production-release-smoke-access-token-verifier.ts",
      releaseSmokeProductionAccessTokenVerifierSha256:
        "2a1463331e350d5284f75ae7eb51ebbf7da74e0951b826a4e21130f2b4648b76",
      releaseSmokeDeploymentBindings:
        "src/shared/config/deployment-bindings.ts",
      releaseSmokeDeploymentBindingsSha256:
        "6915b0b698bee4d7872e1beedbd4bbf79923e6e858c8d5267e6c549c25c0e98c",
      productionSmokeModel: "scripts/production-smoke-canary.ts",
      productionSmokePersistenceMigration:
        "supabase/migrations/0015_production_smoke_canary.sql",
      productionSmokePersistenceMigrationSha256:
        "ecc8b4b53f319f877a3e5dc50d9690e1a36d94d5ee123d81d33a4eb1820687f8",
      productionSmokePersistencePgtap:
        "supabase/tests/0015_production_smoke_canary.pgtap.sql",
      productionSmokePersistencePgtapSha256:
        "f1cc8366f5dafa9b9aa28fa7334c9a2e4ffa555e6e62b7e0f09d7d31eb8998e3",
      productionSmokeRunnerStatus: "ready-protected-live-production",
      productionSmokeAdapter:
        "src/adapters/production-smoke-canary-adapter.ts",
      productionSmokeAdapterSha256:
        "feaaec6b9f27d962d6a0b73c8d69647f9268ece996fc2ebd9b99e34d23b61b90",
      productionSmokeRunnerSha256:
        "7bef5273a1c712acda38d4ce49539c1cadde866e1c71edd14d3c8721233efc4f",
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
      productionSmokePrincipalStatus: "verified",
      productionCustomDomain: "gamebase.elek.li",
      productionDeploymentEnabled: true,
      productionDeploymentRequiredSecrets: [
        "VERCEL_TOKEN",
        "SUPABASE_ACCESS_TOKEN",
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
        "ce8e6d3af7dd3098c0938b0152baca73acd3af71bfecbda49e9d413e97f0e58a",
      productionDeploymentSourceManifestBuilderSha256:
        "589afce50b16f0d4e6896ad091b9621a96065ad6f2a15c7d9c16d7e95ed1405a",
      productionDeploymentSourceManifestSchemaSha256:
        "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      vercelDeploymentAdapterSha256:
        "93060646e4f06fefe23adc9723641756a4e037d745519567bafa0f7e0f99d0d6",
      productionSmokeContractSha256:
        "aab60949aa19dbec335d9012ce10d751a273bc244b35bab9bdc10861892f83ea",
      productionSmokeModelSha256:
        "ad7e15f92fc1abc20a66507752834569f0b1676149982f3f0b9d478d641f6534",
      productionRestoreModelSha256:
        "96604eb799d32eefff62297efafe8e18cca595cc6d4505083f60ead85402f028",
      productionRestoreExecutorSha256:
        "bdeb49c6fa4f0d67e9b2135454c85e44b658729484e815db43e38fe4fbed53d5",
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
    expect(evidenceSchema.properties.schemaVersion).toEqual({ const: 3 });
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
    expect(evidenceSchema.properties.failure).toMatchObject({
      additionalProperties: false,
      required: ["actionKind", "failureCode", "errorCode"],
      properties: {
        actionKind: { const: "run-production-smoke" },
        failureCode: {
          enum: ["smoke-execution-crash", "smoke-execution-timeout"],
        },
        httpStatus: { type: "integer", minimum: 100, maximum: 599 },
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
    expect(rolledBackEvidence?.smoke?.required).toContain("failure");
    expect(evidenceSchema.properties.smoke.properties.failure).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["name", "safeDetail"],
      properties: {
        name: { const: "ProductionCanaryResidueMismatchError" },
        safeDetail: { type: "string", minLength: 1, maxLength: 256 },
      },
    });
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
      object: { const: 2 },
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
    expect(workflow).toMatch(
      /- name: Strictly verify current Production schema[\s\S]*?env:\s*\n\s*PRODUCTION_MIGRATION_CA_CERT: \$\{\{ secrets\.PRODUCTION_MIGRATION_CA_CERT \}\}[\s\S]*?PRODUCTION_MIGRATION_DATABASE_URL: \$\{\{ secrets\.PRODUCTION_MIGRATION_DATABASE_URL \}\}[\s\S]*?run: pnpm release:migration:verify/,
    );
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

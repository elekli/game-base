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
      productionDeploymentModel: "scripts/production-deployment-release.ts",
      productionDeploymentModelSha256:
        "e491156ff423e03872d95175236f86f3cde936b3254fe81d706e53776a96d093",
      productionDeploymentStatus:
        "blocked-external-prerequisites-and-staging-safety-verification",
      vercelDeploymentAdapter: "scripts/vercel-deployment-rest-adapter.ts",
      vercelDeploymentAdapterStatus:
        "request-contract-ready-live-mutations-disabled",
      stagedProductionSafetyStatus: "auto-assign-disablement-unverified",
      vercelRestTransport: "scripts/vercel-rest-transport.ts",
      vercelRestTransportSha256:
        "1c10b85c3dd0d8b8712193edc33c3d1812bf8cc5f981e3adcc4f257da0ad3e65",
      productionDeploymentSourceManifestBuilder:
        "scripts/production-deployment-source-manifest.ts",
      productionDeploymentSourceManifestSchema:
        ".github/production-deployment-source-manifest.schema.json",
      productionSmokeContract: ".github/production-smoke-contract.json",
      releaseSmokeRoute: "src/app/api/internal/release-smoke/route.ts",
      releaseSmokeRouteSha256:
        "99594c244e4fc78c00d4d282b9fafb3974fe1b96760248fa07db1665c5461428",
      releaseSmokeHandler: "src/app/api/internal/release-smoke/handler.ts",
      releaseSmokeHandlerSha256:
        "7e85a4fc08c429cbb9b1e8c9f825eb31882d75e8c6da1f9020706e2aecd162f4",
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
        "fail-closed-pending-principal-db-storage-route-and-live-runner",
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
        "6f6296eb86e4eabf2138bac2ef0bb48151dded0b1883d1324b1cc93edc900018",
      productionDeploymentSourceManifestBuilderSha256:
        "2d6e5c5f805cf8a39ae186bebf63535bf128039d9b1b52ea6f478e879df90a67",
      productionDeploymentSourceManifestSchemaSha256:
        "ae59ff741751d62e5b4a423cd6da6f410b263137453cf00397d5246ad0c7904f",
      vercelDeploymentAdapterSha256:
        "e95dbbcd680c012ff5c56dc0aa5886a89b0ad9ef368f02a79ee27e31458cd014",
      productionSmokeContractSha256:
        "4394d99c7888e4048b5e7e48206d2b1f3b24bb367531becf0978de6fad0ca269",
      productionSmokeModelSha256:
        "5aacb6018c3a94ed2532c90817d3c82a97a03ef2e08d9f2f1b1931d8f2e36fe6",
      productionRestoreModelSha256:
        "4bedd522a39f3792141ebb79d83a6b3d461c3a53e5ce28f1bbfd4c6de4323ae8",
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
    expect(evidenceSchema.properties.canaryContractVersion).toEqual({ const: 2 });
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
});

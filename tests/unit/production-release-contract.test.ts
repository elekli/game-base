import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { checkProductionReleaseContract } from "../../scripts/check-production-release-contract";

describe("production release contract", () => {
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

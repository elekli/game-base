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
    const verification = workflow.indexOf("Verify exact main commit and successful CI");
    const candidateCheckout = workflow.indexOf('git checkout --detach "$COMMIT_SHA"');
    const repositoryScripts = workflow.indexOf("pnpm install --frozen-lockfile");

    expect(trustedCheckout).toBeGreaterThan(-1);
    expect(verification).toBeGreaterThan(trustedCheckout);
    expect(candidateCheckout).toBeGreaterThan(verification);
    expect(repositoryScripts).toBeGreaterThan(candidateCheckout);
  });
});

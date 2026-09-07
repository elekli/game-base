import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("production restore workflow", () => {
  it("keeps secrets behind exact-main CI and uploads only sanitized JSON evidence", async () => {
    const workflow = await readFile(".github/workflows/production-restore-drill.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request):/m);
    expect(workflow).toContain("test \"$execution_sha\" = \"$COMMIT_SHA\"");
    expect(workflow).toContain("actions/workflows/ci.yml/runs?head_sha=${execution_sha}");
    expect(workflow).toContain("environment:\n      name: Production");
    expect(workflow).toContain("PRODUCTION_MIGRATION_DATABASE_URL: ${{ secrets.PRODUCTION_MIGRATION_DATABASE_URL }}");
    expect(workflow).toContain("PRODUCTION_MIGRATION_CA_CERT: ${{ secrets.PRODUCTION_MIGRATION_CA_CERT }}");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(workflow).toContain("path: ${{ runner.temp }}/evidence/production-restore.json");
    expect(workflow).not.toMatch(/path:.*\.dump/);
  });
});

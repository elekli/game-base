import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validatePreviewReplayWorkflow } from "../../scripts/preview-workflow-contract";

const workflowPath = ".github/workflows/preview-supabase-replay.yml";

describe("Preview replay workflow contract", () => {
  it("accepts the guarded main-only workflow", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(validatePreviewReplayWorkflow(workflow)).toEqual([]);
  });

  it.each([
    ["required confirmation", "        required: true", "        required: false"],
    [
      "confirmation wiring",
      "          PREVIEW_RESET_CONFIRMATION: ${{ inputs.confirmation }}",
      "          PREVIEW_RESET_CONFIRMATION: RESET_PREVIEW_ONLY",
    ],
    [
      "explicit non-main rejection",
      "        if: github.ref != 'refs/heads/main'",
      "        if: github.ref == 'refs/heads/main'",
    ],
    ["non-main failure", "          exit 1", "          echo \"rejected\""],
  ])("rejects a workflow missing %s", async (_, expected, replacement) => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(validatePreviewReplayWorkflow(workflow.replace(expected, replacement))).not.toEqual([]);
  });
});

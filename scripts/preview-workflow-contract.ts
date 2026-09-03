type WorkflowLine = Readonly<{
  indent: number;
  text: string;
}>;

function parseLines(contents: string): WorkflowLine[] {
  return contents
    .split("\n")
    .map((line) => ({
      indent: line.length - line.trimStart().length,
      text: line.trim(),
    }))
    .filter(({ text }) => text.length > 0 && !text.startsWith("#"));
}

function blockAfter(
  lines: readonly WorkflowLine[],
  indent: number,
  text: string,
): readonly WorkflowLine[] | null {
  const start = lines.findIndex((line) => line.indent === indent && line.text === text);
  if (start === -1) return null;

  const block: WorkflowLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.indent <= indent) break;
    block.push(line);
  }
  return block;
}

function hasEntry(block: readonly WorkflowLine[] | null, indent: number, text: string): boolean {
  return block?.some((line) => line.indent === indent && line.text === text) ?? false;
}

function stepBlock(
  block: readonly WorkflowLine[] | null,
  name: string,
): readonly WorkflowLine[] | null {
  if (block === null) return null;
  const start = block.findIndex((line) => line.indent === 6 && line.text === `- name: ${name}`);
  if (start === -1) return null;

  const step: WorkflowLine[] = [];
  for (const line of block.slice(start + 1)) {
    if (line.indent <= 6) break;
    step.push(line);
  }
  return step;
}

export function validatePreviewReplayWorkflow(contents: string): readonly string[] {
  const lines = parseLines(contents);
  const violations: string[] = [];
  const requireBlock = (
    block: readonly WorkflowLine[] | null,
    label: string,
  ): readonly WorkflowLine[] => {
    if (block === null) {
      violations.push(`missing:${label}`);
      return [];
    }
    return block;
  };

  const dispatch = requireBlock(blockAfter(lines, 0, "on:"), "workflow-dispatch");
  const dispatchEvent = requireBlock(blockAfter(dispatch, 2, "workflow_dispatch:"), "workflow-dispatch-event");
  const inputs = requireBlock(blockAfter(dispatchEvent, 4, "inputs:"), "workflow-inputs");
  const confirmation = requireBlock(blockAfter(inputs, 6, "confirmation:"), "confirmation-input");
  if (!hasEntry(confirmation, 8, "required: true")) violations.push("confirmation:not-required");
  if (!hasEntry(confirmation, 8, "type: string")) violations.push("confirmation:not-string");
  if (!hasEntry(confirmation, 8, "description: Type RESET_PREVIEW_ONLY to authorize resetting Preview.")) {
    violations.push("confirmation:missing-description");
  }

  const jobs = requireBlock(blockAfter(lines, 0, "jobs:"), "jobs");
  const refGuard = requireBlock(blockAfter(jobs, 2, "ref-guard:"), "ref-guard");
  if (!hasEntry(refGuard, 4, "runs-on: ubuntu-latest")) violations.push("ref-guard:not-runnable");
  const guardSteps = requireBlock(blockAfter(refGuard, 4, "steps:"), "ref-guard-steps");
  const rejectStep = requireBlock(stepBlock(guardSteps, "Reject non-main dispatch"), "non-main-rejection-step");
  if (!hasEntry(rejectStep, 8, "if: github.ref != 'refs/heads/main'")) {
    violations.push("non-main-rejection:not-conditional");
  }
  if (!hasEntry(rejectStep, 8, "run: |") || !hasEntry(rejectStep, 10, "exit 1")) {
    violations.push("non-main-rejection:not-failing");
  }

  const replay = requireBlock(blockAfter(jobs, 2, "replay:"), "replay");
  if (!hasEntry(replay, 4, "needs: ref-guard")) violations.push("replay:not-dependent-on-ref-guard");
  if (!hasEntry(replay, 4, "if: github.ref == 'refs/heads/main' && needs.ref-guard.result == 'success'")) {
    violations.push("replay:not-main-only");
  }
  if (!hasEntry(replay, 4, "environment: preview")) violations.push("replay:not-preview-environment");
  const replaySteps = requireBlock(blockAfter(replay, 4, "steps:"), "replay-steps");
  const replayCommandStep = requireBlock(
    stepBlock(replaySteps, "Replay migrations and run named security checks"),
    "replay-command-step",
  );
  if (!hasEntry(replayCommandStep, 10, "PREVIEW_RESET_CONFIRMATION: ${{ inputs.confirmation }}")) {
    violations.push("confirmation:not-wired-to-replay");
  }

  const concurrency = requireBlock(blockAfter(lines, 0, "concurrency:"), "concurrency");
  if (!hasEntry(concurrency, 2, "cancel-in-progress: false")) {
    violations.push("concurrency:not-serial");
  }

  const actionRefs = lines
    .filter((line) => line.text.startsWith("uses: "))
    .map((line) => line.text.slice("uses: ".length).split(" ")[0]);
  if (actionRefs.length === 0 || actionRefs.some((action) => !/@[0-9a-f]{40}$/.test(action))) {
    violations.push("actions:not-pinned");
  }

  return violations;
}

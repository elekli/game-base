import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  assertPendingMigrationPlan,
  buildPendingMigrationPlan,
  buildReleaseIdentity,
  buildReleaseRecords,
  completePreparedNormalMigrationRelease,
  parsePendingMigrationInput,
  publishLedgerPullRequest,
  runLedgerRecovery,
  runNormalMigrationRelease,
} from "../../scripts/production-migration-release";

const migration = {
  version: "0007",
  name: "revoke_public_platform_trigger_execute",
  filename: "0007_revoke_public_platform_trigger_execute.sql",
  sha256: "a".repeat(64),
};
const pendingSetSha256 = createHash("sha256")
  .update(JSON.stringify([migration]))
  .digest("hex");
const publicationIdentity = buildReleaseIdentity("123", 1, "b".repeat(40), pendingSetSha256);
const publicationPath = `.github/production-migration-ledger/${publicationIdentity}.json`;
const execFileAsync = promisify(execFile);

describe("production migration release records", () => {
  it("forwards the exact workflow argv through the pnpm package script", async () => {
    const root = process.cwd();
    const runnerTemp = await mkdtemp(path.join(tmpdir(), "release-plan-cli-"));
    const pendingInput = '["0007_revoke_public_platform_trigger_execute.sql"]';
    try {
      const workflow = await readFile(path.join(root, ".github/workflows/production-release.yml"), "utf8");
      const invocation = /^\s*run: (pnpm release:migration:plan[^\n]+)$/m.exec(workflow)?.[1];
      expect(invocation).toBe(
        'pnpm release:migration:plan plan-from-input "$PENDING_INPUT" "$GITHUB_WORKSPACE" "$RUNNER_TEMP/expected-plan.json"',
      );
      await execFileAsync("/bin/bash", ["-euo", "pipefail", "-c", invocation!], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          PENDING_INPUT: pendingInput,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const actual = JSON.parse(await readFile(path.join(runnerTemp, "expected-plan.json"), "utf8"));
      await expect(buildPendingMigrationPlan(root, pendingInput)).resolves.toEqual(actual);
    } finally {
      await rm(runnerTemp, { recursive: true, force: true });
    }
  });

  function normalPorts(overrides: Partial<Parameters<typeof runNormalMigrationRelease>[0]> = {}) {
    const events: string[] = [];
    const plan = { pendingMigrations: [migration], pendingSetSha256 };
    return {
      events,
      ports: {
        async resolveMain() { events.push("resolve-main"); return "b".repeat(40); },
        async preflight() { events.push("preflight"); return plan; },
        async persistPlan() { events.push("persist-plan"); },
        async apply() { events.push("apply"); },
        async strictVerify() { events.push("strict"); },
        async persistSuccess() { events.push("persist-success"); },
        ...overrides,
      },
    };
  }

  const normalInput = {
    candidateSha: "b".repeat(40),
    executionSha: "b".repeat(40),
    pendingInput: '["0007_revoke_public_platform_trigger_execute.sql"]',
  };

  it("runs both exact preflights and rechecks main immediately before apply", async () => {
    const { ports, events } = normalPorts();
    await runNormalMigrationRelease(ports, normalInput);
    expect(events).toEqual([
      "resolve-main", "preflight", "persist-plan", "preflight",
      "resolve-main", "apply", "strict", "persist-success",
    ]);
  });

  it("refuses a main advance after preflight without calling apply", async () => {
    let resolution = 0;
    const { ports, events } = normalPorts({
      async resolveMain() {
        events.push("resolve-main");
        resolution += 1;
        return (resolution === 1 ? "b" : "c").repeat(40);
      },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("main advanced before migration apply");
    expect(events).not.toContain("apply");
    expect(events).not.toContain("persist-success");
  });

  it("refuses an apply when the verified execution commit differs from the candidate", async () => {
    const { ports, events } = normalPorts();
    await expect(runNormalMigrationRelease(ports, {
      ...normalInput,
      executionSha: "c".repeat(40),
    })).rejects.toThrow("apply candidate and execution commit must match");
    expect(events).toEqual([]);
  });

  it("fails before preflight when main advances while apply waits for Production approval", async () => {
    const { ports, events } = normalPorts({
      async resolveMain() { events.push("resolve-main"); return "c".repeat(40); },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("execution commit is not current main");
    expect(events).toEqual(["resolve-main"]);
  });

  it("rejects preflight byte drift before apply", async () => {
    let attempt = 0;
    const { ports, events } = normalPorts({
      async preflight() {
        events.push("preflight");
        attempt += 1;
        const changed = { ...migration, sha256: (attempt === 1 ? "a" : "c").repeat(64) };
        return {
          pendingMigrations: [changed],
          pendingSetSha256: createHash("sha256").update(JSON.stringify([changed])).digest("hex"),
        };
      },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("preflight plans changed between reads");
    expect(events).not.toContain("apply");
  });

  it("classifies an apply throw as verified after strict confirms the exact target", async () => {
    const { ports, events } = normalPorts({
      async apply() { events.push("apply"); throw new Error("partial apply"); },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).resolves.toMatchObject({
      applyOutcome: "verified-after-ambiguous-apply",
    });
    expect(events).toContain("strict");
    expect(events).toContain("persist-success");
  });

  it("blocks success when strict verification fails", async () => {
    const { ports, events } = normalPorts({
      async strictVerify() { events.push("strict"); throw new Error("strict failed"); },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("strict post-apply verification failed");
    expect(events).not.toContain("persist-success");
  });

  it("blocks success when both apply and strict verification fail", async () => {
    const { ports, events } = normalPorts({
      async apply() { events.push("apply"); throw new Error("ambiguous apply"); },
      async strictVerify() { events.push("strict"); throw new Error("strict failed"); },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("migration apply failed and strict diagnostic failed");
    expect(events).not.toContain("persist-success");
  });

  it("keeps a successful mutation recoverable when record persistence fails", async () => {
    const { ports, events } = normalPorts({
      async persistSuccess() { events.push("persist-success"); throw new Error("ledger unavailable"); },
    });
    await expect(runNormalMigrationRelease(ports, normalInput)).rejects.toThrow("ledger unavailable");
    expect(events.slice(-3)).toEqual(["apply", "strict", "persist-success"]);
  });

  it("completes mutation without creating records in the apply step", async () => {
    const { ports, events } = normalPorts();
    const plan = { migrations: [migration], pendingSetSha256 };
    await expect(completePreparedNormalMigrationRelease(ports, normalInput, plan)).resolves.toEqual({
      plan,
      applyOutcome: "applied-and-verified",
    });
    expect(events).toEqual(["preflight", "resolve-main", "apply", "strict"]);
    expect(events).not.toContain("persist-success");
  });

  function recoveryPorts(overrides: Partial<Parameters<typeof runLedgerRecovery>[0]> = {}) {
    const events: string[] = [];
    const planText = `${JSON.stringify({ pendingMigrations: [migration], pendingSetSha256 })}\n`;
    return {
      events,
      ports: {
        async resolveMain() { return "c".repeat(40); },
        async isAncestor() { return true; },
        async loadSourceRun() {
          return {
            id: "122", runAttempt: 2, repository: "elekli/game-base",
            workflowPath: ".github/workflows/production-release.yml", event: "workflow_dispatch",
            headSha: "b".repeat(40),
          };
        },
        async loadSourceJobs() {
          return [{ id: 77, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
            { name: "Authorize exact migration attempt", conclusion: "success" },
            { name: "Apply and strict-verify exact migration suffix", conclusion: "success" },
          ] }];
        },
        async loadPlanArtifact() {
          const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`;
          return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 };
        },
        async readMigrationAtSource() { return "migration bytes"; },
        async readMigrationAtExecution() { return "migration bytes"; },
        async recoveryStrictVerify() { events.push("strict"); },
        async persistLedger() { events.push("ledger"); return "created" as const; },
        ...overrides,
      },
    };
  }

  const recoveryInput = {
    sourceRunId: "122", sourceRunAttempt: 2,
    pendingInput: '["0007_revoke_public_platform_trigger_execute.sql"]',
    repository: "elekli/game-base",
    workflowPath: ".github/workflows/production-release.yml",
    sourceSha: "b".repeat(40),
    executionSha: "c".repeat(40),
  };

  it("recovers a source commit that remains an ancestor after main advances", async () => {
    const bytesMigration = { ...migration, sha256: createHash("sha256").update("migration bytes").digest("hex") };
    const planText = `${JSON.stringify({ pendingMigrations: [bytesMigration], pendingSetSha256: createHash("sha256").update(JSON.stringify([bytesMigration])).digest("hex") })}\n`;
    const ancestryChecks: string[][] = [];
    const { ports, events } = recoveryPorts({
      async isAncestor(ancestor, descendant) { ancestryChecks.push([ancestor, descendant]); return true; },
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
    });
    await runLedgerRecovery(ports, recoveryInput);
    expect(ancestryChecks).toEqual([["b".repeat(40), "c".repeat(40)]]);
    expect(events).toEqual(["strict", "ledger"]);
  });

  it("rejects a main advance during recovery before writing the ledger", async () => {
    let reads = 0;
    const bytesMigration = { ...migration, sha256: createHash("sha256").update("migration bytes").digest("hex") };
    const planText = `${JSON.stringify({ pendingMigrations: [bytesMigration], pendingSetSha256: createHash("sha256").update(JSON.stringify([bytesMigration])).digest("hex") })}\n`;
    const { ports, events } = recoveryPorts({
      async resolveMain() { reads += 1; return (reads === 1 ? "c" : "d").repeat(40); },
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
    });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("main advanced during ledger recovery");
    expect(events).not.toContain("ledger");
  });

  it("fails closed when main advances while recovery waits for Production approval", async () => {
    const { ports, events } = recoveryPorts({
      async resolveMain() { return "d".repeat(40); },
    });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("execution commit is not current main");
    expect(events).toEqual([]);
  });

  it("rejects a same-name apply step in the wrong job", async () => {
    const { ports } = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "spoof", runAttempt: 2, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "success" },
      ] }]; },
    });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("source mutation job identity is invalid");
  });

  it("rejects duplicate apply step names and the wrong run attempt", async () => {
    const duplicate = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "success" },
      ] }]; },
    });
    await expect(runLedgerRecovery(duplicate.ports, recoveryInput)).rejects.toThrow("source mutation step did not prove execution began");
    const wrongJobAttempt = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 1, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "success" },
      ] }]; },
    });
    await expect(runLedgerRecovery(wrongJobAttempt.ports, recoveryInput)).rejects.toThrow("source mutation job identity is invalid");
    const wrongAttempt = recoveryPorts({ async loadSourceRun() { return { id: "122", runAttempt: 1, repository: "elekli/game-base", workflowPath: ".github/workflows/production-release.yml", event: "workflow_dispatch", headSha: "b".repeat(40) }; } });
    await expect(runLedgerRecovery(wrongAttempt.ports, recoveryInput)).rejects.toThrow("source run identity is invalid");
  });

  it("requires one successful authorization but permits a failed mutation step", async () => {
    const bytesMigration = { ...migration, sha256: createHash("sha256").update("migration bytes").digest("hex") };
    const planText = `${JSON.stringify({ pendingMigrations: [bytesMigration], pendingSetSha256: createHash("sha256").update(JSON.stringify([bytesMigration])).digest("hex") })}\n`;
    const failedMutation = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "failure" },
      ] }]; },
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
    });
    await expect(runLedgerRecovery(failedMutation.ports, recoveryInput)).resolves.toMatchObject({ sourceSha: "b".repeat(40) });
    const cancelledMutation = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "cancelled" },
      ] }]; },
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
    });
    await expect(runLedgerRecovery(cancelledMutation.ports, recoveryInput)).resolves.toMatchObject({ sourceSha: "b".repeat(40) });
    const missingAuthorization = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
        { name: "Apply and strict-verify exact migration suffix", conclusion: "failure" },
      ] }]; },
    });
    await expect(runLedgerRecovery(missingAuthorization.ports, recoveryInput)).rejects.toThrow("authorization step must be unique and successful");
    const duplicateAuthorization = recoveryPorts({
      async loadSourceJobs() { return [{ id: 1, name: "Apply migration and preserve commit-bound ledger", runAttempt: 2, steps: [
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Authorize exact migration attempt", conclusion: "success" },
        { name: "Apply and strict-verify exact migration suffix", conclusion: "cancelled" },
      ] }]; },
    });
    await expect(runLedgerRecovery(duplicateAuthorization.ports, recoveryInput)).rejects.toThrow("authorization step must be unique and successful");
  });

  it("rejects cancellation after authorization but before apply even if Production now matches", async () => {
    const { ports, events } = recoveryPorts({
      async loadSourceJobs() { return [{
        id: 1,
        name: "Apply migration and preserve commit-bound ledger",
        runAttempt: 2,
        steps: [
          { name: "Authorize exact migration attempt", conclusion: "success" },
          { name: "Apply and strict-verify exact migration suffix", conclusion: "skipped" },
        ],
      }]; },
      async recoveryStrictVerify() { events.push("strict-db-already-at-target"); },
    });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("source mutation step did not prove execution began");
    expect(events).toEqual([]);
  });

  it("rejects artifact digest mismatch before strict verification", async () => {
    const { ports, events } = recoveryPorts({ async loadPlanArtifact() { return { text: "{}\n", metadataDigest: `sha256:${"d".repeat(64)}`, downloadedArchiveDigest: `sha256:${"e".repeat(64)}`, runAttempt: 2 }; } });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("source plan artifact digest mismatch");
    expect(events).not.toContain("strict");
  });

  it("rejects an artifact from a different run attempt", async () => {
    const { ports } = recoveryPorts({ async loadPlanArtifact() { return { text: "{}\n", metadataDigest: `sha256:${"d".repeat(64)}`, downloadedArchiveDigest: `sha256:${"d".repeat(64)}`, runAttempt: 1 }; } });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("source plan artifact run attempt mismatch");
  });

  it("fails closed when repository bytes differ from the source plan", async () => {
    const { ports } = recoveryPorts();
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("source migration bytes do not match the plan");
  });

  it("accepts an existing identical ledger but rejects identity collisions", async () => {
    const bytesMigration = { ...migration, sha256: createHash("sha256").update("migration bytes").digest("hex") };
    const planText = `${JSON.stringify({ pendingMigrations: [bytesMigration], pendingSetSha256: createHash("sha256").update(JSON.stringify([bytesMigration])).digest("hex") })}\n`;
    const same = recoveryPorts({
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
      async persistLedger() { return "same" as const; },
    });
    await expect(runLedgerRecovery(same.ports, recoveryInput)).resolves.toMatchObject({ sourceSha: "b".repeat(40) });
    const collision = recoveryPorts({
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
      async persistLedger() { return "different" as const; },
    });
    await expect(runLedgerRecovery(collision.ports, recoveryInput)).rejects.toThrow("ledger identity already has different evidence");
  });

  it("can retry recovery after strict succeeded but ledger persistence failed", async () => {
    const bytesMigration = { ...migration, sha256: createHash("sha256").update("migration bytes").digest("hex") };
    const planText = `${JSON.stringify({ pendingMigrations: [bytesMigration], pendingSetSha256: createHash("sha256").update(JSON.stringify([bytesMigration])).digest("hex") })}\n`;
    let persistAttempts = 0;
    const { ports, events } = recoveryPorts({
      async loadPlanArtifact() { const digest = `sha256:${createHash("sha256").update(planText).digest("hex")}`; return { text: planText, metadataDigest: digest, downloadedArchiveDigest: digest, runAttempt: 2 }; },
      async persistLedger() { persistAttempts += 1; if (persistAttempts === 1) throw new Error("artifact unavailable"); return "created" as const; },
    });
    await expect(runLedgerRecovery(ports, recoveryInput)).rejects.toThrow("artifact unavailable");
    await expect(runLedgerRecovery(ports, recoveryInput)).resolves.toMatchObject({ sourceSha: "b".repeat(40) });
    expect(events.filter((event) => event === "strict")).toHaveLength(2);
  });

  it("builds the approved remediation identity from repository bytes", async () => {
    await expect(
      buildPendingMigrationPlan(
        process.cwd(),
        '["0007_revoke_public_platform_trigger_execute.sql"]',
      ),
    ).resolves.toMatchObject({
      pendingMigrations: [
        {
          version: "0007",
          name: "revoke_public_platform_trigger_execute",
          filename: "0007_revoke_public_platform_trigger_execute.sql",
          sha256:
            "1d6c4e631a16951117f8bb4e0b780b8fa510b03a27032a15b81088c92bb1a97a",
        },
      ],
    });
  });

  it("accepts only an ordered canonical pending filename array", () => {
    expect(
      parsePendingMigrationInput('["0007_revoke_public_platform_trigger_execute.sql"]'),
    ).toEqual(["0007_revoke_public_platform_trigger_execute.sql"]);
    for (const input of [
      "[]",
      '["0007_x.sql", "0008_y.sql"]',
      '["0008_y.sql","0007_x.sql"]',
      '["0007_x.sql","0007_x.sql"]',
      '["0007_x.sql; echo owned"]',
    ]) {
      expect(() => parsePendingMigrationInput(input)).toThrow(
        "ProductionMigrationReleaseError",
      );
    }
  });

  it("binds operator input to the exact preflight identities and set hash", () => {
    expect(
      assertPendingMigrationPlan(
        '["0007_revoke_public_platform_trigger_execute.sql"]',
        { pendingMigrations: [migration], pendingSetSha256 },
      ),
    ).toEqual({ migrations: [migration], pendingSetSha256 });
    expect(() =>
      assertPendingMigrationPlan('["0008_other.sql"]', {
        pendingMigrations: [migration],
        pendingSetSha256,
      }),
    ).toThrow("operator pending migration input does not match preflight");
  });

  it("creates sanitized commit-bound evidence and a hash-linked ledger", () => {
    const records = buildReleaseRecords({
      commit: "b".repeat(40),
      actor: "release-operator",
      runId: "123",
      result: "success",
      pendingMigrations: [migration],
      pendingSetSha256,
      utcTime: "2026-09-06T12:00:00.000Z",
    });
    expect(JSON.parse(records.ledgerText)).toMatchObject({
      commit: "b".repeat(40),
      migrations: [migration],
      actor: "release-operator",
      utcTime: "2026-09-06T12:00:00.000Z",
      result: "success",
      sourceReleaseRun: { id: "123", attempt: 1 },
      successBasis: "strict-exact-target",
      recoveryAction: {
        missingLedgerAfterSuccess: "ledger-recovery",
        incompatibleDatabase: "forward-fix",
        destructiveRollback: "never-reset",
      },
      evidenceSha256: createHash("sha256")
        .update(records.evidenceText)
        .digest("hex"),
    });
    expect(records.evidenceText).not.toMatch(/databaseUrl|certificate|secret|payload/i);
  });

  it("reconstructs the same canonical ledger from a later recovery run", () => {
    const shared = {
      commit: "b".repeat(40), runId: "123", runAttempt: 2,
      releaseIdentity: buildReleaseIdentity("123", 2, "b".repeat(40), pendingSetSha256),
      result: "success" as const, pendingMigrations: [migration], pendingSetSha256,
    };
    const applied = buildReleaseRecords({ ...shared, actor: "first", utcTime: "2026-09-06T10:00:00.000Z" });
    const recovered = buildReleaseRecords({ ...shared, actor: "first", utcTime: "2026-09-06T10:00:00.000Z" });
    const retried = buildReleaseRecords({ ...shared, actor: "first", utcTime: "2026-09-06T10:00:00.000Z" });
    expect(recovered.ledgerText).toBe(applied.ledgerText);
    expect(recovered.evidenceText).toBe(applied.evidenceText);
    expect(retried.evidenceText).toBe(recovered.evidenceText);
  });

  it("rejects a release identity that does not match its source release content", () => {
    expect(() => buildReleaseRecords({
      commit: "b".repeat(40), actor: "operator", runId: "123", runAttempt: 2,
      releaseIdentity: buildReleaseIdentity("123", 1, "b".repeat(40), pendingSetSha256),
      result: "success", pendingMigrations: [migration],
      pendingSetSha256, utcTime: "2026-09-06T10:00:00.000Z",
    })).toThrow("record release identity is invalid");
  });

  it("publishes a new canonical ledger branch and pull request", async () => {
    const events: string[] = [];
    const result = await publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: false, ledgerText: null }; }, async listPullRequests() { return []; },
      async createBranch() { events.push("branch"); }, async createPullRequest() { events.push("pr"); },
    }, { identity: publicationIdentity, ledgerPath: publicationPath, ledgerText: "same\n" });
    expect(result).toBe("created");
    expect(events).toEqual(["branch", "pr"]);
  });

  it("treats existing identical ledger publication as success and rejects differing evidence", async () => {
    const identity = publicationIdentity;
    const branch = `release-ledger/${identity}`;
    const title = `chore: record production migration ${identity}`;
    const same = { identity, ledgerPath: publicationPath, ledgerText: "same\n" };
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: "same\n" }; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "OPEN", isDraft: false, mergedAt: null }]; }, async createBranch() {}, async createPullRequest() {},
    }, same)).resolves.toBe("same");
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: "different\n" }; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "OPEN", isDraft: false, mergedAt: null }]; }, async createBranch() {}, async createPullRequest() {},
    }, same)).rejects.toThrow("ledger branch identity differs");
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: null }; },
      async listPullRequests() { return []; }, async createBranch() {}, async createPullRequest() {},
    }, same)).rejects.toThrow("ledger branch identity differs");
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return "same\n"; }, async readBranchLedger() { return { branchExists: false, ledgerText: null }; },
      async listPullRequests() { return []; }, async createBranch() {}, async createPullRequest() {},
    }, same)).rejects.toThrow("canonical pull request evidence is missing");
  });

  it("recreates only a missing PR and rejects duplicate or mismatched PR identity", async () => {
    const identity = publicationIdentity;
    const branch = `release-ledger/${identity}`;
    const title = `chore: record production migration ${identity}`;
    let created = 0;
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: "same\n" }; }, async listPullRequests() { return []; },
      async createBranch() {}, async createPullRequest() { created += 1; },
    }, { identity, ledgerPath: publicationPath, ledgerText: "same\n" })).resolves.toBe("reopened");
    expect(created).toBe(1);
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: "same\n" }; },
      async listPullRequests() { return [
        { head: branch, base: "main", title, state: "OPEN", isDraft: false, mergedAt: null },
        { head: branch, base: "main", title, state: "OPEN", isDraft: false, mergedAt: null },
      ]; }, async createBranch() {}, async createPullRequest() {},
    }, { identity, ledgerPath: publicationPath, ledgerText: "same\n" })).rejects.toThrow("duplicate pull requests");
    await expect(publishLedgerPullRequest({
      async readMainLedger() { return null; }, async readBranchLedger() { return { branchExists: true, ledgerText: "same\n" }; },
      async listPullRequests() { return [{ head: branch, base: "main", title: "wrong", state: "OPEN", isDraft: false, mergedAt: null }]; }, async createBranch() {}, async createPullRequest() {},
    }, { identity, ledgerPath: publicationPath, ledgerText: "same\n" })).rejects.toThrow("pull request identity differs");
  });

  it("accepts only open non-draft or merged ledger pull requests", async () => {
    const identity = publicationIdentity;
    const branch = `release-ledger/${identity}`;
    const title = `chore: record production migration ${identity}`;
    const input = { identity, ledgerPath: publicationPath, ledgerText: "same\n" };
    const shared = {
      async readBranchLedger() { return { branchExists: true, ledgerText: "same\n" }; },
      async createBranch() {}, async createPullRequest() {},
    };
    await expect(publishLedgerPullRequest({
      ...shared, async readMainLedger() { return "same\n"; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "CLOSED", isDraft: false, mergedAt: null }]; },
    }, input)).rejects.toThrow("closed without merge");
    await expect(publishLedgerPullRequest({
      ...shared, async readMainLedger() { return null; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "OPEN", isDraft: true, mergedAt: null }]; },
    }, input)).rejects.toThrow("draft");
    await expect(publishLedgerPullRequest({
      ...shared, async readMainLedger() { return "same\n"; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "MERGED", isDraft: false, mergedAt: "2026-09-06T12:00:00Z" }]; },
    }, input)).resolves.toBe("same");
    await expect(publishLedgerPullRequest({
      ...shared, async readMainLedger() { return null; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "MERGED", isDraft: false, mergedAt: "2026-09-06T12:00:00Z" }]; },
    }, input)).rejects.toThrow("merged pull request is missing its main ledger");
    await expect(publishLedgerPullRequest({
      ...shared, async readMainLedger() { return "same\n"; },
      async readBranchLedger() { return { branchExists: false, ledgerText: null }; },
      async listPullRequests() { return [{ head: branch, base: "main", title, state: "OPEN", isDraft: false, mergedAt: null }]; },
    }, input)).rejects.toThrow("ledger branch identity differs");
  });
});

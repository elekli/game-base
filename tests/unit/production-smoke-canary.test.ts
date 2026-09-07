import { describe, expect, it } from "vitest";

import {
  PRODUCTION_SMOKE_CHECKS,
  ProductionCanaryActionMismatchError,
  ProductionCanaryBoundsExceededError,
  ProductionCanaryCleanupMismatchError,
  ProductionCanaryGenerationMismatchError,
  ProductionCanaryResidueMismatchError,
  ProductionCanaryUncertainStateError,
  consumeProductionSmokeCanaryTerminal,
  createProductionSmokeCanary as createCanary,
  isProductionSmokeCanaryEvidence,
  transitionProductionSmokeCanary as transitionCanary,
  type ProductionSmokeCanary,
  type ProductionSmokeCanaryEvent,
  type ProductionSmokeCanaryEventPayload,
} from "../../scripts/production-smoke-canary";

const SHA = "a".repeat(40);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

function createProductionSmokeCanary(input: {
  executionSha: string;
  generation?: string;
}) {
  return createCanary({
    ...input,
    generation: input.generation ?? GENERATION,
  });
}

function transitionProductionSmokeCanary(
  canary: ProductionSmokeCanary,
  event: ProductionSmokeCanaryEventPayload & { generation?: string },
) {
  return transitionCanary(canary, {
    ...event,
    generation: event.generation ?? canary.generation,
    actionSequence: canary.next.actionSequence,
  } as ProductionSmokeCanaryEvent);
}

function readChecks() {
  return {
    "custom-domain-owner-access": "passed" as const,
    "direct-origin-denied": "passed" as const,
    "authenticated-library-read": "passed" as const,
    "runtime-database-read": "passed" as const,
    "private-storage-direct-denied": "passed" as const,
  };
}

function reachWritingRow() {
  let canary = createProductionSmokeCanary({ executionSha: SHA });
  canary = transitionProductionSmokeCanary(canary, {
    kind: "counts-observed",
    purpose: "baseline",
    rowCount: 0,
    objectCount: 0,
  });
  return transitionProductionSmokeCanary(canary, {
    kind: "fixed-read-checks-observed",
    checks: readChecks(),
    requestIds: [REQUEST_ID],
  });
}

describe("production smoke canary", () => {
  it("uses one fixed identity, location, and check set", () => {
    const canary = createProductionSmokeCanary({
      executionSha: SHA,
      generation: GENERATION,
    });

    expect(canary.generation).toBe(GENERATION);
    expect(canary.identity).toBe(`release-smoke-v1:${SHA}`);
    expect(canary.rowId).toBe("7355773e-c3b5-4e5d-9f07-55ac0e22f384");
    expect(canary.objectPath).toBe("release-smoke-v1/canary.json");
    expect(canary.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(PRODUCTION_SMOKE_CHECKS).toEqual([
      "custom-domain-owner-access",
      "direct-origin-denied",
      "authenticated-library-read",
      "runtime-database-read",
      "private-storage-direct-denied",
      "canary-row-round-trip",
      "canary-object-round-trip",
      "canary-cleanup-counts",
    ]);
  });

  it("keeps identity and payload hash stable across attempt generations", () => {
    const first = createProductionSmokeCanary({ executionSha: SHA });
    const second = createProductionSmokeCanary({
      executionSha: SHA,
      generation: "22222222-2222-4222-8222-222222222222",
    });

    expect(second.identity).toBe(first.identity);
    expect(second.payloadSha256).toBe(first.payloadSha256);
    expect(second.generation).not.toBe(first.generation);
  });

  it("cleans only same-generation safe pre-Storage row residue", () => {
    const canary = createProductionSmokeCanary({ executionSha: SHA });
    const cleaning = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 1,
      objectCount: 0,
      rowIdentity: canary.identity,
      rowGeneration: GENERATION,
      rowPayloadSha256: canary.payloadSha256,
      rowPhase: "row_claimed",
    });

    expect(cleaning.next).toMatchObject({
      kind: "cleanup-exact-canary",
      expectedPhase: "row_claimed",
      generation: GENERATION,
    });
  });

  it("rejects late events from another generation", () => {
    const canary = createProductionSmokeCanary({ executionSha: SHA });

    expect(() =>
      transitionProductionSmokeCanary(canary, {
        kind: "counts-observed",
        generation: "22222222-2222-4222-8222-222222222222",
        purpose: "baseline",
        rowCount: 0,
        objectCount: 0,
      }),
    ).toThrow(ProductionCanaryGenerationMismatchError);
  });

  it("stops without automatic cleanup when a mutation outcome is uncertain", () => {
    const uncertain = transitionProductionSmokeCanary(reachWritingRow(), {
      kind: "operation-uncertain",
      safeDetail: "Storage response was not observed",
    });

    expect(uncertain.phase).toBe("manual-recovery-required");
    expect(uncertain.next).toMatchObject({ kind: "stop" });
    expect(uncertain.failure).toBeInstanceOf(ProductionCanaryUncertainStateError);
  });

  it("runs from an empty baseline through bounded mutation and clean cleanup", () => {
    let canary = createProductionSmokeCanary({ executionSha: SHA });
    canary = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 0,
      objectCount: 0,
    });
    expect(canary.next).toMatchObject({
      kind: "run-fixed-read-checks",
      checks: PRODUCTION_SMOKE_CHECKS.slice(0, 5),
    });

    canary = transitionProductionSmokeCanary(canary, {
      kind: "fixed-read-checks-observed",
      checks: readChecks(),
      requestIds: [REQUEST_ID],
    });
    canary = transitionProductionSmokeCanary(canary, { kind: "row-written" });
    canary = transitionProductionSmokeCanary(canary, { kind: "object-written" });
    expect(canary.next).toEqual({
      kind: "verify-round-trip",
      generation: GENERATION,
      actionSequence: 5,
      identity: `release-smoke-v1:${SHA}`,
      rowId: "7355773e-c3b5-4e5d-9f07-55ac0e22f384",
      objectPath: "release-smoke-v1/canary.json",
      payloadSha256: canary.payloadSha256,
      maxRowCount: 1,
      maxObjectCount: 1,
    });

    canary = transitionProductionSmokeCanary(canary, {
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 1,
      rowIdentity: `release-smoke-v1:${SHA}`,
      objectIdentity: `release-smoke-v1:${SHA}`,
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
      rowPhase: "object_written",
      rowPayloadSha256: canary.payloadSha256,
      objectPayloadSha256: canary.payloadSha256,
      requestIds: [REQUEST_ID],
    });
    canary = transitionProductionSmokeCanary(canary, { kind: "cleanup-finished" });
    canary = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "cleanup",
      rowCount: 0,
      objectCount: 0,
    });

    expect(canary.phase).toBe("succeeded");
    expect(canary.evidence).toEqual({
      namespace: "release-smoke-v1",
      executionSha: SHA,
      generation: GENERATION,
      identity: `release-smoke-v1:${SHA}`,
      payloadSha256: canary.payloadSha256,
      counts: {
        baseline: { row: 0, object: 0 },
        mutation: { row: 1, object: 1 },
        cleanup: { row: 0, object: 0 },
      },
      checks: Object.fromEntries(PRODUCTION_SMOKE_CHECKS.map((check) => [check, "passed"])),
      requestIds: [REQUEST_ID],
    });
    expect(isProductionSmokeCanaryEvidence(canary.evidence)).toBe(true);
    expect(consumeProductionSmokeCanaryTerminal(canary)).toMatchObject({
      outcome: "passed",
      evidence: canary.evidence,
    });
    expect(consumeProductionSmokeCanaryTerminal({ ...canary })).toBeUndefined();
  });

  it("does not accept round-trip data fenced by another generation", () => {
    let canary = transitionProductionSmokeCanary(reachWritingRow(), {
      kind: "row-written",
    });
    canary = transitionProductionSmokeCanary(canary, { kind: "object-written" });
    canary = transitionProductionSmokeCanary(canary, {
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 1,
      rowIdentity: canary.identity,
      objectIdentity: canary.identity,
      rowGeneration: "22222222-2222-4222-8222-222222222222",
      objectGeneration: "22222222-2222-4222-8222-222222222222",
      rowPhase: "object_written",
      rowPayloadSha256: canary.payloadSha256,
      objectPayloadSha256: canary.payloadSha256,
      requestIds: [REQUEST_ID],
    });

    expect(canary.phase).toBe("manual-recovery-required");
    expect(canary.next).toMatchObject({ kind: "stop" });
  });

  it("rejects incomplete, extra, or failed per-check read evidence", () => {
    const baseline = createProductionSmokeCanary({ executionSha: SHA });
    const running = transitionProductionSmokeCanary(baseline, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 0,
      objectCount: 0,
    });

    expect(() =>
      transitionProductionSmokeCanary(running, {
        kind: "fixed-read-checks-observed",
        checks: {
          ...readChecks(),
          "unexpected-read": "passed",
        } as never,
        requestIds: [REQUEST_ID],
      }),
    ).toThrow(ProductionCanaryResidueMismatchError);
    expect(() =>
      transitionProductionSmokeCanary(running, {
        kind: "fixed-read-checks-observed",
        checks: {
          ...readChecks(),
          "custom-domain-owner-access": "failed",
        },
        requestIds: [REQUEST_ID],
      }),
    ).toThrow(ProductionCanaryResidueMismatchError);
  });

  it("cleans exact residue after deterministic mutation failures, then retains the primary failure", () => {
    const rowAmbiguous = transitionProductionSmokeCanary(reachWritingRow(), {
      kind: "operation-failed",
      safeDetail: "row write outcome is ambiguous",
    });
    expect(rowAmbiguous.next).toMatchObject({ kind: "cleanup-exact-canary" });

    const objectOnly = transitionProductionSmokeCanary(
      transitionProductionSmokeCanary(reachWritingRow(), { kind: "row-written" }),
      { kind: "operation-failed", safeDetail: "object write failed" },
    );
    expect(objectOnly.next).toMatchObject({ kind: "cleanup-exact-canary" });

    let mismatch = transitionProductionSmokeCanary(reachWritingRow(), { kind: "row-written" });
    mismatch = transitionProductionSmokeCanary(mismatch, { kind: "object-written" });
    mismatch = transitionProductionSmokeCanary(mismatch, {
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 1,
      rowIdentity: `release-smoke-v1:${SHA}`,
      objectIdentity: `release-smoke-v1:${SHA}`,
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
      rowPhase: "object_written",
      rowPayloadSha256: mismatch.payloadSha256,
      objectPayloadSha256: "b".repeat(64),
      requestIds: [REQUEST_ID],
    });
    expect(mismatch.phase).toBe("manual-recovery-required");
    expect(mismatch.next).toMatchObject({ kind: "stop" });

    let cleaned = transitionProductionSmokeCanary(rowAmbiguous, { kind: "cleanup-finished" });
    cleaned = transitionProductionSmokeCanary(cleaned, {
      kind: "counts-observed",
      purpose: "cleanup",
      rowCount: 0,
      objectCount: 0,
    });
    expect(cleaned.phase).toBe("failed");
    expect(cleaned.failure).toBeInstanceOf(ProductionCanaryResidueMismatchError);
    expect(cleaned.failure?.message).toContain("row write outcome is ambiguous");
    expect(consumeProductionSmokeCanaryTerminal(cleaned)).toEqual({
      outcome: "failed-cleanup-complete",
      evidence: {
        outcome: "failed",
        generation: GENERATION,
        requestIds: [REQUEST_ID],
        counts: { cleanup: { row: 0, object: 0 } },
        checks: { "canary-cleanup-counts": "passed" },
      },
    });
    expect(
      consumeProductionSmokeCanaryTerminal({ ...cleaned }),
    ).toBeUndefined();
  });

  it("names cleanup failure without discarding the mutation failure context", () => {
    const cleaning = transitionProductionSmokeCanary(reachWritingRow(), {
      kind: "operation-failed",
      safeDetail: "row write outcome is ambiguous",
    });

    expect(() =>
      transitionProductionSmokeCanary(cleaning, {
        kind: "operation-failed",
        safeDetail: "cleanup transport failed",
      }),
    ).toThrow(/row write outcome is ambiguous/);
  });

  it("cleans only complete residue that belongs to the same execution", () => {
    const canary = createProductionSmokeCanary({ executionSha: SHA });
    const residue = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 1,
      objectCount: 1,
      rowIdentity: `release-smoke-v1:${SHA}`,
      objectIdentity: `release-smoke-v1:${SHA}`,
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
      rowPhase: "object_written",
      rowPayloadSha256: canary.payloadSha256,
      objectPayloadSha256: canary.payloadSha256,
    });
    expect(residue.next).toMatchObject({ kind: "cleanup-exact-canary" });

    expect(() =>
      transitionProductionSmokeCanary(canary, {
        kind: "counts-observed",
        purpose: "baseline",
        rowCount: 1,
        objectCount: 1,
        rowIdentity: `release-smoke-v1:${"b".repeat(40)}`,
        objectIdentity: `release-smoke-v1:${SHA}`,
        rowGeneration: GENERATION,
        objectGeneration: GENERATION,
        rowPhase: "object_written",
        rowPayloadSha256: canary.payloadSha256,
        objectPayloadSha256: canary.payloadSha256,
      }),
    ).toThrow(ProductionCanaryResidueMismatchError);
    expect(() =>
      transitionProductionSmokeCanary(canary, {
        kind: "counts-observed",
        purpose: "baseline",
        rowCount: 1,
        objectCount: 0,
        rowIdentity: `release-smoke-v1:${SHA}`,
        rowGeneration: GENERATION,
        rowPhase: "object_write_uncertain",
        rowPayloadSha256: canary.payloadSha256,
      }),
    ).toThrow(ProductionCanaryResidueMismatchError);

    expect(() =>
      transitionProductionSmokeCanary(canary, {
        kind: "counts-observed",
        purpose: "baseline",
        rowCount: 1,
        objectCount: 1,
        rowIdentity: `release-smoke-v1:${SHA}`,
        objectIdentity: `release-smoke-v1:${SHA}`,
        rowGeneration: GENERATION,
        objectGeneration: GENERATION,
        rowPhase: "object_written",
        rowPayloadSha256: "b".repeat(64),
        objectPayloadSha256: canary.payloadSha256,
      }),
    ).toThrow(ProductionCanaryResidueMismatchError);
  });

  it("rejects bounds and cleanup mismatches with named errors", () => {
    const canary = createProductionSmokeCanary({ executionSha: SHA });
    expect(() =>
      transitionProductionSmokeCanary(canary, {
        kind: "counts-observed",
        purpose: "baseline",
        rowCount: 2,
        objectCount: 0,
      }),
    ).toThrow(ProductionCanaryBoundsExceededError);

    const cleaning = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 1,
      objectCount: 1,
      rowIdentity: `release-smoke-v1:${SHA}`,
      objectIdentity: `release-smoke-v1:${SHA}`,
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
      rowPhase: "object_written",
      rowPayloadSha256: canary.payloadSha256,
      objectPayloadSha256: canary.payloadSha256,
    });
    const verifying = transitionProductionSmokeCanary(cleaning, {
      kind: "cleanup-finished",
    });
    expect(() =>
      transitionProductionSmokeCanary(verifying, {
        kind: "counts-observed",
        purpose: "cleanup",
        rowCount: 0,
        objectCount: 1,
      }),
    ).toThrow(ProductionCanaryCleanupMismatchError);
    });
  });

  it("rejects late events from an earlier action in the same generation", () => {
    let canary = createProductionSmokeCanary({ executionSha: SHA });
    canary = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "baseline",
      rowCount: 1,
      objectCount: 0,
      rowIdentity: canary.identity,
      rowGeneration: GENERATION,
      rowPayloadSha256: canary.payloadSha256,
      rowPhase: "row_claimed",
    });
    const staleCleanupSequence = canary.next.actionSequence;
    canary = transitionProductionSmokeCanary(canary, { kind: "cleanup-finished" });
    canary = transitionProductionSmokeCanary(canary, {
      kind: "counts-observed",
      purpose: "cleanup",
      rowCount: 0,
      objectCount: 0,
    });

    expect(() =>
      transitionCanary(canary, {
        kind: "cleanup-finished",
        generation: GENERATION,
        actionSequence: staleCleanupSequence,
      }),
    ).toThrow(ProductionCanaryActionMismatchError);
  });

  it("rejects non-canonical uppercase generations", () => {
    expect(() =>
      createProductionSmokeCanary({
        executionSha: SHA,
        generation: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ).toThrow(ProductionCanaryGenerationMismatchError);
  });

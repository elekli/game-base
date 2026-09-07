import { createHash } from "node:crypto";

export const PRODUCTION_SMOKE_NAMESPACE = "release-smoke-v1" as const;
export const PRODUCTION_SMOKE_ROW_ID =
  "7355773e-c3b5-4e5d-9f07-55ac0e22f384" as const;
export const PRODUCTION_SMOKE_OBJECT_PATH =
  "release-smoke-v1/canary.json" as const;

export const PRODUCTION_SMOKE_CHECKS = [
  "custom-domain-owner-access",
  "direct-origin-denied",
  "authenticated-library-read",
  "runtime-database-read",
  "private-storage-direct-denied",
  "canary-row-round-trip",
  "canary-object-round-trip",
  "canary-cleanup-counts",
] as const;

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PRODUCTION_SMOKE_REQUEST_IDS = 16;

export class ProductionCanaryError extends Error {
  constructor(readonly safeDetail: string, name = "ProductionCanaryError") {
    super(`${name}: ${safeDetail}`);
    this.name = name;
  }
}

export class ProductionCanaryResidueMismatchError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryResidueMismatchError");
  }
}

export class ProductionCanaryBoundsExceededError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryBoundsExceededError");
  }
}

export class ProductionCanaryCleanupMismatchError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryCleanupMismatchError");
  }
}

export class ProductionCanaryGenerationMismatchError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryGenerationMismatchError");
  }
}

export class ProductionCanaryActionMismatchError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryActionMismatchError");
  }
}

export class ProductionCanaryUncertainStateError extends ProductionCanaryError {
  constructor(safeDetail: string) {
    super(safeDetail, "ProductionCanaryUncertainStateError");
  }
}

export const PRODUCTION_SMOKE_PERSISTED_PHASES = [
  "row_claimed",
  "object_write_pending",
  "object_written",
  "object_write_uncertain",
  "cleanup_pending",
  "cleanup_uncertain",
] as const;
export type ProductionSmokePersistedPhase =
  (typeof PRODUCTION_SMOKE_PERSISTED_PHASES)[number];

type CountPair = Readonly<{ row: number; object: number }>;
export type ProductionSmokeCheck = (typeof PRODUCTION_SMOKE_CHECKS)[number];
const FIXED_READ_CHECKS = [
  "custom-domain-owner-access",
  "direct-origin-denied",
  "authenticated-library-read",
  "runtime-database-read",
  "private-storage-direct-denied",
] as const satisfies ReadonlyArray<ProductionSmokeCheck>;
type FixedReadCheck = (typeof FIXED_READ_CHECKS)[number];
type PassedCheckMap = Readonly<Record<ProductionSmokeCheck, "passed">>;

export type ProductionSmokeCanaryEvidence = Readonly<{
  namespace: typeof PRODUCTION_SMOKE_NAMESPACE;
  executionSha: string;
  generation: string;
  identity: string;
  payloadSha256: string;
  counts: Readonly<{
    baseline: CountPair;
    mutation: CountPair;
    cleanup: CountPair;
  }>;
  checks: PassedCheckMap;
  requestIds: ReadonlyArray<string>;
}>;

export type ProductionSmokeFailedCleanupEvidence = Readonly<{
  outcome: "failed";
  generation: string;
  requestIds: ReadonlyArray<string>;
  counts: Readonly<{ cleanup: CountPair }>;
  checks: Readonly<{ "canary-cleanup-counts": "passed" }>;
}>;

export type ProductionSmokeCanaryAction = (
  | Readonly<{
      kind: "inspect-canary-counts";
      generation: string;
      purpose: "baseline" | "cleanup";
      rowId: typeof PRODUCTION_SMOKE_ROW_ID;
      objectPath: typeof PRODUCTION_SMOKE_OBJECT_PATH;
    }>
  | Readonly<{
      kind: "run-fixed-read-checks";
      generation: string;
      checks: ReadonlyArray<FixedReadCheck>;
    }>
  | Readonly<{
      kind: "write-canary-row";
      generation: string;
      rowId: string;
      identity: string;
      payloadSha256: string;
    }>
  | Readonly<{
      kind: "write-canary-object";
      generation: string;
      objectPath: string;
      identity: string;
      payloadSha256: string;
    }>
  | Readonly<{
      kind: "verify-round-trip";
      generation: string;
      identity: string;
      rowId: string;
      objectPath: string;
      payloadSha256: string;
      maxRowCount: 1;
      maxObjectCount: 1;
    }>
  | Readonly<{
      kind: "cleanup-exact-canary";
      expectedPhase: "row_claimed" | "cleanup_pending";
      generation: string;
      identity: string;
      rowId: string;
      objectPath: string;
      payloadSha256: string;
    }>
  | Readonly<{ kind: "stop" }>
) & Readonly<{ actionSequence: number }>;

type CanaryPhase =
  | "inspecting-baseline"
  | "cleaning-residue"
  | "running-read-checks"
  | "writing-row"
  | "writing-object"
  | "verifying-round-trip"
  | "cleaning-canary"
  | "verifying-cleanup"
  | "manual-recovery-required"
  | "succeeded"
  | "failed";

export type ProductionSmokeCanary = Readonly<{
  phase: CanaryPhase;
  executionSha: string;
  generation: string;
  namespace: typeof PRODUCTION_SMOKE_NAMESPACE;
  identity: string;
  payloadSha256: string;
  rowId: typeof PRODUCTION_SMOKE_ROW_ID;
  objectPath: typeof PRODUCTION_SMOKE_OBJECT_PATH;
  next: ProductionSmokeCanaryAction;
  cleanupPurpose?: "residue" | "final" | "failure";
  baselineCounts?: CountPair;
  mutationCounts?: CountPair;
  checks: Readonly<Partial<Record<ProductionSmokeCheck, "passed">>>;
  requestIds: ReadonlyArray<string>;
  failure?: ProductionCanaryError;
  evidence?: ProductionSmokeCanaryEvidence;
}>;

export type ProductionSmokeCanaryTerminal =
  | Readonly<{
      outcome: "passed";
      evidence: ProductionSmokeCanaryEvidence;
    }>
  | Readonly<{
      outcome: "failed-cleanup-complete";
      evidence: ProductionSmokeFailedCleanupEvidence;
    }>;

const terminalCanaryCapabilities = new WeakMap<
  ProductionSmokeCanary,
  ProductionSmokeCanaryTerminal
>();

export type ProductionSmokeCanaryEventPayload =
  | Readonly<{
      kind: "counts-observed";
      purpose: "baseline" | "cleanup";
      rowCount: number;
      objectCount: number;
      rowIdentity?: string;
      objectIdentity?: string;
      rowGeneration?: string;
      objectGeneration?: string;
      rowPhase?: ProductionSmokePersistedPhase;
      rowPayloadSha256?: string;
      objectPayloadSha256?: string;
    }>
  | Readonly<{
      kind: "fixed-read-checks-observed";
      checks: Readonly<Record<FixedReadCheck, "passed" | "failed">>;
      requestIds: ReadonlyArray<string>;
    }>
  | Readonly<{ kind: "row-written" }>
  | Readonly<{ kind: "object-written" }>
  | Readonly<{
      kind: "round-trip-observed";
      rowCount: number;
      objectCount: number;
      rowIdentity?: string;
      objectIdentity?: string;
      rowGeneration?: string;
      objectGeneration?: string;
      rowPhase?: ProductionSmokePersistedPhase;
      rowPayloadSha256?: string;
      objectPayloadSha256?: string;
      requestIds: ReadonlyArray<string>;
    }>
  | Readonly<{ kind: "cleanup-finished" }>
  | Readonly<{ kind: "operation-uncertain"; safeDetail: string }>
  | Readonly<{ kind: "operation-failed"; safeDetail: string }>;

export type ProductionSmokeCanaryEvent = ProductionSmokeCanaryEventPayload &
  Readonly<{ generation: string; actionSequence: number }>;

function inspectCounts(
  purpose: "baseline" | "cleanup",
  generation: string,
  actionSequence: number,
): ProductionSmokeCanaryAction {
  return {
    kind: "inspect-canary-counts",
    generation,
    actionSequence,
    purpose,
    rowId: PRODUCTION_SMOKE_ROW_ID,
    objectPath: PRODUCTION_SMOKE_OBJECT_PATH,
  };
}

function cleanupAction(
  identity: string,
  generation: string,
  payloadSha256: string,
  actionSequence: number,
  expectedPhase: "row_claimed" | "cleanup_pending" = "cleanup_pending",
): ProductionSmokeCanaryAction {
  return {
    kind: "cleanup-exact-canary",
    actionSequence,
    expectedPhase,
    generation,
    identity,
    rowId: PRODUCTION_SMOKE_ROW_ID,
    objectPath: PRODUCTION_SMOKE_OBJECT_PATH,
    payloadSha256,
  };
}

function isCountPair(value: unknown, expected: CountPair): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["row", "object"])) return false;
  return value.row === expected.row && value.object === expected.object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const observed = Object.keys(value);
  return observed.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactPassedChecks(value: unknown, checks: ReadonlyArray<string>): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, checks) &&
    checks.every((check) => value[check] === "passed")
  );
}

function validateCounts(rowCount: number, objectCount: number): void {
  if (
    !Number.isInteger(rowCount) ||
    !Number.isInteger(objectCount) ||
    rowCount < 0 ||
    objectCount < 0 ||
    rowCount > 1 ||
    objectCount > 1
  ) {
    throw new ProductionCanaryBoundsExceededError("canary count exceeded its 1/1 bound");
  }
}

function validRequestIds(
  requestIds: unknown,
  minimum = 0,
): requestIds is ReadonlyArray<string> {
  return (
    Array.isArray(requestIds) &&
    requestIds.length >= minimum &&
    requestIds.length <= MAX_PRODUCTION_SMOKE_REQUEST_IDS &&
    new Set(requestIds).size === requestIds.length &&
    requestIds.every((requestId) => typeof requestId === "string" && REQUEST_ID.test(requestId))
  );
}

export function calculateProductionSmokePayloadSha256(executionSha: string): string {
  if (!FULL_SHA.test(executionSha)) {
    throw new ProductionCanaryResidueMismatchError("execution SHA is invalid");
  }
  const identity = `${PRODUCTION_SMOKE_NAMESPACE}:${executionSha}`;
  return createHash("sha256")
    .update(
      JSON.stringify({
        namespace: PRODUCTION_SMOKE_NAMESPACE,
        identity,
        rowId: PRODUCTION_SMOKE_ROW_ID,
        objectPath: PRODUCTION_SMOKE_OBJECT_PATH,
      }),
    )
    .digest("hex");
}

function appendRequestIds(
  current: ReadonlyArray<string>,
  observed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!validRequestIds(observed)) {
    throw new ProductionCanaryResidueMismatchError("request identifiers are invalid or exceed the canary bound");
  }
  const requestIds = [...new Set([...current, ...observed])];
  if (!validRequestIds(requestIds)) {
    throw new ProductionCanaryResidueMismatchError("request identifiers exceed the canary bound");
  }
  return requestIds;
}

function cleanupFailure(canary: ProductionSmokeCanary, safeDetail: string): ProductionCanaryCleanupMismatchError {
  const primary = canary.failure;
  const context = primary ? `${primary.name}: ${primary.safeDetail}` : "no primary mutation failure";
  return new ProductionCanaryCleanupMismatchError(`cleanup failed after ${context}; ${safeDetail}`);
}

function cleanupAfterMutationFailure(
  canary: ProductionSmokeCanary,
  safeDetail: string,
): ProductionSmokeCanary {
  const failure = new ProductionCanaryResidueMismatchError(safeDetail);
  return {
    ...canary,
    phase: "cleaning-canary",
    cleanupPurpose: "failure",
    failure,
    next: cleanupAction(canary.identity, canary.generation, canary.payloadSha256, canary.next.actionSequence + 1),
  };
}

export function isProductionSmokeCanaryEvidence(
  value: unknown,
): value is ProductionSmokeCanaryEvidence {
  if (!isRecord(value) || !hasExactKeys(value, ["namespace", "executionSha", "generation", "identity", "payloadSha256", "counts", "checks", "requestIds"])) {
    return false;
  }
  if (
    value.namespace !== PRODUCTION_SMOKE_NAMESPACE ||
    typeof value.executionSha !== "string" ||
    !FULL_SHA.test(value.executionSha) ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation) ||
    value.identity !== `${PRODUCTION_SMOKE_NAMESPACE}:${value.executionSha}` ||
    typeof value.payloadSha256 !== "string" ||
    !SHA256.test(value.payloadSha256) ||
    value.payloadSha256 !==
      calculateProductionSmokePayloadSha256(value.executionSha) ||
    !isRecord(value.counts) ||
    !hasExactKeys(value.counts, ["baseline", "mutation", "cleanup"]) ||
    !isCountPair(value.counts.baseline, { row: 0, object: 0 }) ||
    !isCountPair(value.counts.mutation, { row: 1, object: 1 }) ||
    !isCountPair(value.counts.cleanup, { row: 0, object: 0 }) ||
    !hasExactPassedChecks(value.checks, PRODUCTION_SMOKE_CHECKS) ||
    !validRequestIds(value.requestIds, 1)
  ) {
    return false;
  }
  return true;
}

export function consumeProductionSmokeCanaryTerminal(
  canary: ProductionSmokeCanary,
): ProductionSmokeCanaryTerminal | undefined {
  return terminalCanaryCapabilities.get(canary);
}

export function createProductionSmokeCanary(input: {
  executionSha: string;
  generation: string;
}): ProductionSmokeCanary {
  if (!FULL_SHA.test(input.executionSha)) {
    throw new ProductionCanaryResidueMismatchError("execution SHA is invalid");
  }
  if (!GENERATION.test(input.generation)) {
    throw new ProductionCanaryGenerationMismatchError("generation is not UUIDv4");
  }
  const identity = `${PRODUCTION_SMOKE_NAMESPACE}:${input.executionSha}`;
  const payloadSha256 = calculateProductionSmokePayloadSha256(
    input.executionSha,
  );
  return {
    phase: "inspecting-baseline",
    executionSha: input.executionSha,
    generation: input.generation,
    namespace: PRODUCTION_SMOKE_NAMESPACE,
    identity,
    payloadSha256,
    rowId: PRODUCTION_SMOKE_ROW_ID,
    objectPath: PRODUCTION_SMOKE_OBJECT_PATH,
    next: inspectCounts("baseline", input.generation, 1),
    checks: {},
    requestIds: [],
  };
}

export function transitionProductionSmokeCanary(
  canary: ProductionSmokeCanary,
  event: ProductionSmokeCanaryEvent,
): ProductionSmokeCanary {
  if (event.actionSequence !== canary.next.actionSequence) {
    throw new ProductionCanaryActionMismatchError(
      "event action sequence does not match the active action",
    );
  }
  if (event.generation !== canary.generation) {
    throw new ProductionCanaryGenerationMismatchError(
      "event generation does not match the active attempt",
    );
  }
  if (event.kind === "operation-uncertain") {
    return {
      ...canary,
      phase: "manual-recovery-required",
      failure: new ProductionCanaryUncertainStateError(event.safeDetail),
      next: { kind: "stop", actionSequence: canary.next.actionSequence + 1 },
    };
  }
  if (event.kind === "operation-failed") {
    if (canary.phase === "cleaning-canary" || canary.phase === "cleaning-residue" || canary.phase === "verifying-cleanup") {
      throw cleanupFailure(canary, event.safeDetail);
    }
    if (canary.phase === "writing-row" || canary.phase === "writing-object" || canary.phase === "verifying-round-trip") {
      return cleanupAfterMutationFailure(canary, event.safeDetail);
    }
    throw new ProductionCanaryResidueMismatchError(event.safeDetail);
  }

  if (canary.phase === "inspecting-baseline" && event.kind === "counts-observed" && event.purpose === "baseline") {
    validateCounts(event.rowCount, event.objectCount);
    if (event.rowCount === 0 && event.objectCount === 0) {
      return { ...canary, phase: "running-read-checks", baselineCounts: { row: 0, object: 0 }, next: { kind: "run-fixed-read-checks", generation: canary.generation, actionSequence: canary.next.actionSequence + 1, checks: FIXED_READ_CHECKS } };
    }
    if (event.rowCount === 1 && event.objectCount === 0 && event.rowIdentity === canary.identity && event.rowGeneration === canary.generation && event.rowPayloadSha256 === canary.payloadSha256 && event.rowPhase === "row_claimed") {
      return { ...canary, phase: "cleaning-residue", cleanupPurpose: "residue", next: cleanupAction(canary.identity, canary.generation, canary.payloadSha256, canary.next.actionSequence + 1, "row_claimed") };
    }
    if (event.rowCount === 1 && event.objectCount === 1 && event.rowIdentity === canary.identity && event.objectIdentity === canary.identity && event.rowGeneration === canary.generation && event.objectGeneration === canary.generation && event.rowPayloadSha256 === canary.payloadSha256 && event.objectPayloadSha256 === canary.payloadSha256 && event.rowPhase === "object_written") {
      return { ...canary, phase: "cleaning-residue", cleanupPurpose: "residue", next: cleanupAction(canary.identity, canary.generation, canary.payloadSha256, canary.next.actionSequence + 1) };
    }
    throw new ProductionCanaryResidueMismatchError("baseline residue is partial or belongs to another execution");
  }

  if (canary.phase === "running-read-checks" && event.kind === "fixed-read-checks-observed") {
    if (!hasExactPassedChecks(event.checks, FIXED_READ_CHECKS)) {
      throw new ProductionCanaryResidueMismatchError("fixed read check evidence is incomplete, extra, or failed");
    }
    return { ...canary, phase: "writing-row", checks: { ...canary.checks, ...(event.checks as Readonly<Record<FixedReadCheck, "passed">>) }, requestIds: appendRequestIds(canary.requestIds, event.requestIds), next: { kind: "write-canary-row", generation: canary.generation, actionSequence: canary.next.actionSequence + 1, rowId: canary.rowId, identity: canary.identity, payloadSha256: canary.payloadSha256 } };
  }
  if (canary.phase === "writing-row" && event.kind === "row-written") {
    return { ...canary, phase: "writing-object", next: { kind: "write-canary-object", generation: canary.generation, actionSequence: canary.next.actionSequence + 1, objectPath: canary.objectPath, identity: canary.identity, payloadSha256: canary.payloadSha256 } };
  }
  if (canary.phase === "writing-object" && event.kind === "object-written") {
    return { ...canary, phase: "verifying-round-trip", next: { kind: "verify-round-trip", generation: canary.generation, actionSequence: canary.next.actionSequence + 1, identity: canary.identity, rowId: canary.rowId, objectPath: canary.objectPath, payloadSha256: canary.payloadSha256, maxRowCount: 1, maxObjectCount: 1 } };
  }
  if (canary.phase === "verifying-round-trip" && event.kind === "round-trip-observed") {
    try {
      validateCounts(event.rowCount, event.objectCount);
      if (
        event.rowCount !== 1 ||
        event.objectCount !== 1 ||
        event.rowIdentity !== canary.identity ||
        event.objectIdentity !== canary.identity ||
        event.rowGeneration !== canary.generation ||
        event.objectGeneration !== canary.generation ||
        event.rowPhase !== "object_written" ||
        event.rowPayloadSha256 !== canary.payloadSha256 ||
        event.objectPayloadSha256 !== canary.payloadSha256
      ) {
        return {
          ...canary,
          phase: "manual-recovery-required",
          failure: new ProductionCanaryResidueMismatchError(
            "canary round trip did not return the exact active generation",
          ),
          next: { kind: "stop", actionSequence: canary.next.actionSequence + 1 },
        };
      }
      return { ...canary, phase: "cleaning-canary", cleanupPurpose: "final", mutationCounts: { row: 1, object: 1 }, checks: { ...canary.checks, "canary-row-round-trip": "passed", "canary-object-round-trip": "passed" }, requestIds: appendRequestIds(canary.requestIds, event.requestIds), next: cleanupAction(canary.identity, canary.generation, canary.payloadSha256, canary.next.actionSequence + 1) };
    } catch (error) {
      const safeDetail = error instanceof ProductionCanaryError ? error.safeDetail : "round trip validation failed";
      return {
        ...canary,
        phase: "manual-recovery-required",
        failure: new ProductionCanaryResidueMismatchError(safeDetail),
        next: { kind: "stop", actionSequence: canary.next.actionSequence + 1 },
      };
    }
  }
  if ((canary.phase === "cleaning-canary" || canary.phase === "cleaning-residue") && event.kind === "cleanup-finished") {
    return { ...canary, phase: "verifying-cleanup", next: inspectCounts("cleanup", canary.generation, canary.next.actionSequence + 1) };
  }
  if (canary.phase === "verifying-cleanup" && event.kind === "counts-observed" && event.purpose === "cleanup") {
    try {
      validateCounts(event.rowCount, event.objectCount);
      if (event.rowCount !== 0 || event.objectCount !== 0) {
        throw new ProductionCanaryCleanupMismatchError("canary cleanup did not return to 0/0");
      }
    } catch (error) {
      const safeDetail = error instanceof ProductionCanaryError ? error.safeDetail : "cleanup count validation failed";
      throw cleanupFailure(canary, safeDetail);
    }
    if (canary.cleanupPurpose === "residue") {
      return { ...canary, phase: "running-read-checks", baselineCounts: { row: 0, object: 0 }, cleanupPurpose: undefined, next: { kind: "run-fixed-read-checks", generation: canary.generation, actionSequence: canary.next.actionSequence + 1, checks: FIXED_READ_CHECKS } };
    }
    if (canary.cleanupPurpose === "failure") {
      const failedCanary = {
        ...canary,
        phase: "failed" as const,
        cleanupPurpose: undefined,
        next: { kind: "stop", actionSequence: canary.next.actionSequence + 1 } as const,
      };
      terminalCanaryCapabilities.set(failedCanary, {
        outcome: "failed-cleanup-complete",
        evidence: {
          outcome: "failed",
          generation: canary.generation,
          requestIds: canary.requestIds,
          counts: { cleanup: { row: 0, object: 0 } },
          checks: { "canary-cleanup-counts": "passed" },
        },
      });
      return failedCanary;
    }
    const evidence: ProductionSmokeCanaryEvidence = {
      namespace: canary.namespace,
      executionSha: canary.executionSha,
      generation: canary.generation,
      identity: canary.identity,
      payloadSha256: canary.payloadSha256,
      counts: { baseline: canary.baselineCounts ?? { row: 0, object: 0 }, mutation: canary.mutationCounts ?? { row: 0, object: 0 }, cleanup: { row: 0, object: 0 } },
      checks: {
        ...canary.checks,
        "canary-cleanup-counts": "passed",
      } as PassedCheckMap,
      requestIds: canary.requestIds,
    };
    if (!isProductionSmokeCanaryEvidence(evidence)) {
      throw new ProductionCanaryCleanupMismatchError("completed canary evidence is incomplete");
    }
    const succeededCanary = {
      ...canary,
      phase: "succeeded" as const,
      cleanupPurpose: undefined,
      next: { kind: "stop", actionSequence: canary.next.actionSequence + 1 } as const,
      evidence,
    };
    terminalCanaryCapabilities.set(succeededCanary, {
      outcome: "passed",
      evidence,
    });
    return succeededCanary;
  }

  throw new ProductionCanaryResidueMismatchError(`event ${event.kind} is invalid during ${canary.phase}`);
}

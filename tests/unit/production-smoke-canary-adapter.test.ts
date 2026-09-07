import { describe, expect, it, vi } from "vitest";

import {
  canonicalProductionSmokeObjectBytes,
  createProductionSmokeSessionDatabaseUrl,
  createSupabaseProductionSmokeObjectStore,
  ProductionSmokeCanaryAdapter,
  ProductionSmokeOperationError,
  ProductionSmokeOperationUncertainError,
  type ProductionSmokeDatabase,
  type ProductionSmokeDatabaseSession,
  type ProductionSmokeObjectStore,
} from "../../src/adapters/production-smoke-canary-adapter";
import { calculateProductionSmokePayloadSha256 } from "../../scripts/production-smoke-canary";

const SHA = "a".repeat(40);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const IDENTITY = `release-smoke-v1:${SHA}`;
const HASH = calculateProductionSmokePayloadSha256(SHA);

function operation(
  operationName: "inspect-baseline" | "run-fixed-read-checks" | "write-row" | "write-object" | "verify-round-trip" | "cleanup-exact" | "inspect-cleanup",
  actionSequence: number,
) {
  return { executionSha: SHA, generation: GENERATION, actionSequence, operation: operationName } as const;
}

function harness() {
  let row: {
    rowCount: 0 | 1;
    identity?: string;
    generation?: string;
    actionSequence?: number;
    payloadSha256?: string;
    phase?: "row_claimed" | "object_write_pending" | "object_written" | "object_write_uncertain" | "cleanup_pending" | "cleanup_uncertain";
  } = { rowCount: 0 };
  let objectBytes: Uint8Array | undefined;
  const session: ProductionSmokeDatabaseSession = {
    inspect: vi.fn(async () => ({ ...row })),
    claim: vi.fn(async (input) => {
      if (row.rowCount === 1) return false;
      row = { rowCount: 1, ...input, phase: "row_claimed" };
      return true;
    }),
    transition: vi.fn(async (input) => {
      if (
        row.rowCount !== 1 ||
        row.generation !== input.generation ||
        row.identity !== input.identity ||
        row.payloadSha256 !== input.payloadSha256 ||
        row.actionSequence !== input.expectedActionSequence ||
        row.phase !== input.expectedPhase ||
        input.nextActionSequence < input.expectedActionSequence
      ) return false;
      row = { ...row, phase: input.nextPhase, actionSequence: input.nextActionSequence };
      return true;
    }),
    cleanup: vi.fn(async (input) => {
      if (
        row.rowCount !== 1 ||
        row.generation !== input.generation ||
        row.identity !== input.identity ||
        row.payloadSha256 !== input.payloadSha256 ||
        row.actionSequence !== input.expectedActionSequence ||
        row.phase !== input.expectedPhase
      ) return false;
      row = { rowCount: 0 };
      return true;
    }),
    probeRuntimeDatabase: vi.fn(async () => undefined),
    probeLibraryReadable: vi.fn(async () => undefined),
  };
  const database: ProductionSmokeDatabase = {
    locked: vi.fn(async (callback) => callback(session)),
    close: vi.fn(async () => undefined),
  };
  const objects: ProductionSmokeObjectStore = {
    inspect: vi.fn(async (expected) => {
      if (!objectBytes) return { count: 0 as const, canonical: false };
      const canonical = objectBytes.byteLength === expected.byteLength &&
        objectBytes.every((byte, index) => byte === expected[index]);
      return canonical
        ? { count: 1 as const, canonical: true, identity: IDENTITY, generation: GENERATION, payloadSha256: HASH }
        : { count: 1 as const, canonical: false };
    }),
    upload: vi.fn(async (bytes) => { objectBytes = new Uint8Array(bytes); }),
    remove: vi.fn(async () => { objectBytes = undefined; }),
  };
  return {
    adapter: new ProductionSmokeCanaryAdapter(database, objects),
    database,
    objects,
    row: () => row,
    setObject: (bytes: Uint8Array) => { objectBytes = bytes; },
  };
}

describe("Production smoke canary adapter", () => {
  it("executes the fixed 0/0 to 1/1 to 0/0 path without caller-selected targets", async () => {
    const test = harness();

    await expect(test.adapter.execute(operation("write-row", 3))).resolves.toEqual({ kind: "row-written" });
    await expect(test.adapter.execute(operation("write-object", 4))).resolves.toEqual({ kind: "object-written" });
    await expect(test.adapter.execute(operation("verify-round-trip", 5))).resolves.toMatchObject({
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 1,
      rowPhase: "object_written",
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
    });
    await expect(test.adapter.execute(operation("cleanup-exact", 7))).resolves.toEqual({ kind: "cleanup-finished" });
    await expect(test.adapter.execute(operation("inspect-cleanup", 8))).resolves.toEqual({
      kind: "counts-observed",
      purpose: "cleanup",
      rowCount: 0,
      objectCount: 0,
    });
    expect(test.objects.upload).toHaveBeenCalledWith(
      canonicalProductionSmokeObjectBytes({ executionSha: SHA, generation: GENERATION }),
      expect.any(AbortSignal),
    );
    expect(test.row()).toEqual({ rowCount: 0 });
  });

  it("returns only the two internal read checks and does not claim external checks", async () => {
    const test = harness();
    await expect(test.adapter.execute(operation("run-fixed-read-checks", 2))).resolves.toEqual({
      kind: "fixed-read-checks-observed",
      checks: {
        "authenticated-library-read": "passed",
        "runtime-database-read": "passed",
      },
    });
  });

  it("keeps a non-canonical object and refuses automatic cleanup", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    test.setObject(new TextEncoder().encode("foreign"));

    await expect(test.adapter.execute(operation("cleanup-exact", 6))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    expect(test.objects.remove).not.toHaveBeenCalled();
    expect(test.row()).toMatchObject({ rowCount: 1, phase: "row_claimed" });
  });

  it("recovers an upload response loss only after exact byte readback", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    const bytes = canonicalProductionSmokeObjectBytes({ executionSha: SHA, generation: GENERATION });
    vi.mocked(test.objects.upload).mockImplementationOnce(async () => {
      test.setObject(bytes);
      throw new ProductionSmokeOperationError("response lost");
    });

    await expect(test.adapter.execute(operation("write-object", 4))).resolves.toEqual({ kind: "object-written" });
    expect(test.row()).toMatchObject({ phase: "object_written", actionSequence: 4 });
  });

  it("persists an uncertain phase when a Storage write may finish late", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    vi.mocked(test.objects.upload).mockRejectedValueOnce(
      new ProductionSmokeOperationUncertainError("deadline"),
    );

    await expect(test.adapter.execute(operation("write-object", 4))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    expect(test.row()).toMatchObject({ phase: "object_write_uncertain", actionSequence: 4 });
  });

  it("fences an old same-generation cleanup after a later re-claim", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    await test.adapter.execute(operation("cleanup-exact", 4));
    await test.adapter.execute(operation("write-row", 6));

    await expect(test.adapter.execute(operation("cleanup-exact", 4))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    expect(test.row()).toMatchObject({ rowCount: 1, actionSequence: 6 });
  });

  it("treats an already absent exact cleanup target as idempotent success", async () => {
    const test = harness();
    await expect(test.adapter.execute(operation("cleanup-exact", 6))).resolves.toEqual({
      kind: "cleanup-finished",
    });
    expect(test.objects.remove).not.toHaveBeenCalled();
  });
});

describe("Production smoke database binding", () => {
  it("converts the hosted transaction-pooler URL to the session-pooler port", () => {
    const result = new URL(createProductionSmokeSessionDatabaseUrl(
      "postgres://app_runtime.project:secret@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require",
    ));

    expect(result.hostname).toBe("aws-0-region.pooler.supabase.com");
    expect(result.port).toBe("5432");
    expect(result.username).toBe("app_runtime.project");
    expect(result.searchParams.get("sslmode")).toBe("require");
  });

  it("rejects a hosted database endpoint without a supported pooler port", () => {
    expect(() => createProductionSmokeSessionDatabaseUrl(
      "postgres://app_runtime.project:secret@example.com:6432/postgres?sslmode=require",
    )).toThrow("session-capable endpoint");
  });
});

describe("Production smoke fixed Storage adapter", () => {
  it("uses only the fixed private object path and verifies canonical bytes", async () => {
    const bytes = canonicalProductionSmokeObjectBytes({ executionSha: SHA, generation: GENERATION });
    const files = {
      download: vi.fn(() => ({
        asStream: vi.fn(async () => ({ data: new Blob([bytes.buffer as ArrayBuffer]).stream(), error: null })),
      })),
      upload: vi.fn(async () => ({ data: { path: "release-smoke-v1/canary.json" }, error: null })),
      remove: vi.fn(async () => ({ data: [], error: null })),
    };
    const store = createSupabaseProductionSmokeObjectStore({
      supabaseUrl: "https://example.supabase.co",
      files,
    });

    await expect(store.inspect(bytes)).resolves.toMatchObject({
      count: 1,
      canonical: true,
      identity: IDENTITY,
      generation: GENERATION,
      payloadSha256: HASH,
    });
    await store.upload(bytes);
    await store.remove();
    expect(files.download).toHaveBeenCalledWith(
      "release-smoke-v1/canary.json",
      expect.any(AbortSignal),
    );
    expect(files.upload).toHaveBeenCalledWith(
      "release-smoke-v1/canary.json",
      bytes,
      { contentType: "application/json", upsert: false, cacheControl: "0" },
      expect.any(AbortSignal),
    );
    expect(files.remove).toHaveBeenCalledWith(
      ["release-smoke-v1/canary.json"],
      expect.any(AbortSignal),
    );
  });

  it("reports missing and oversized objects without exposing or deleting bytes", async () => {
    const bytes = canonicalProductionSmokeObjectBytes({ executionSha: SHA, generation: GENERATION });
    const asStream = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { status: 404 } })
      .mockResolvedValueOnce({ data: new Blob([new ArrayBuffer(1025)]).stream(), error: null });
    const download = vi.fn(() => ({ asStream }));
    const store = createSupabaseProductionSmokeObjectStore({
      supabaseUrl: "https://example.supabase.co",
      files: {
        download,
        upload: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(store.inspect(bytes)).resolves.toEqual({ count: 0, canonical: false });
    await expect(store.inspect(bytes)).resolves.toEqual({ count: 1, canonical: false });
  });

  it("aborts the Storage transport and reports uncertainty at its deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const store = createSupabaseProductionSmokeObjectStore({
        supabaseUrl: "https://example.supabase.co",
        files: {
          download: vi.fn(() => ({ asStream: vi.fn() })),
          upload: vi.fn((_path, _bytes, _options, signal) => {
            observedSignal = signal;
            return new Promise<Readonly<{ data: unknown; error: unknown }>>(() => undefined);
          }),
          remove: vi.fn(),
        },
      });
      const assertion = expect(store.upload(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ProductionSmokeOperationUncertainError,
      );
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

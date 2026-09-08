import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  canonicalProductionSmokeMedia,
  createProductionSmokeSessionDatabaseUrl,
  createSupabaseProductionSmokeObjectStore,
  ProductionSmokeCanaryAdapter,
  ProductionSmokeOperationError,
  ProductionSmokeOperationUncertainError,
  type ProductionSmokeDatabase,
  type ProductionSmokeDatabaseSession,
  type CanonicalProductionSmokeMedia,
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
  let storedMedia: Partial<Pick<CanonicalProductionSmokeMedia, "original" | "thumbnail">> | undefined;
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
      if (!storedMedia) return { count: 0 as const, canonical: false };
      const sameBytes = (actual: Uint8Array, wanted: Uint8Array) =>
        actual.byteLength === wanted.byteLength &&
        actual.every((byte, index) => byte === wanted[index]);
      const count = (Number(storedMedia.original !== undefined) +
        Number(storedMedia.thumbnail !== undefined)) as 0 | 1 | 2;
      const canonical = count > 0 &&
        (storedMedia.original === undefined || sameBytes(storedMedia.original, expected.original)) &&
        (storedMedia.thumbnail === undefined || sameBytes(storedMedia.thumbnail, expected.thumbnail));
      return canonical
        ? { count, canonical: true, identity: IDENTITY, generation: GENERATION, payloadSha256: HASH }
        : { count, canonical: false };
    }),
    upload: vi.fn(async (media) => { storedMedia = media; }),
    remove: vi.fn(async () => { storedMedia = undefined; }),
  };
  return {
    adapter: new ProductionSmokeCanaryAdapter(database, objects),
    database,
    objects,
    row: () => row,
    setPhase: (phase: NonNullable<typeof row.phase>, actionSequence: number) => {
      if (row.rowCount !== 1) throw new Error("test row is absent");
      row = { ...row, phase, actionSequence };
    },
    setObject: (media: Partial<Pick<CanonicalProductionSmokeMedia, "original" | "thumbnail">>) => {
      storedMedia = media;
    },
  };
}

describe("Production smoke canary adapter", () => {
  it("generates bounded real PNG and WebP media tied to the attempt generation", async () => {
    const first = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    const second = await canonicalProductionSmokeMedia({
      executionSha: SHA,
      generation: "22222222-2222-4222-8222-222222222222",
    });

    await expect(sharp(first.original).metadata()).resolves.toMatchObject({
      format: "png",
      width: 8,
      height: 8,
    });
    await expect(sharp(first.thumbnail).metadata()).resolves.toMatchObject({
      format: "webp",
      width: 4,
      height: 4,
    });
    expect(first.original.byteLength).toBeLessThanOrEqual(1024);
    expect(first.thumbnail.byteLength).toBeLessThanOrEqual(1024);
    expect(first.original).not.toEqual(second.original);
    expect(first.thumbnail).not.toEqual(second.thumbnail);
  });

  it("executes the fixed 0/0 to 1/2 to 0/0 media path without caller-selected targets", async () => {
    const test = harness();

    await expect(test.adapter.execute(operation("write-row", 3))).resolves.toEqual({ kind: "row-written" });
    await expect(test.adapter.execute(operation("write-object", 4))).resolves.toEqual({ kind: "object-written" });
    await expect(test.adapter.execute(operation("verify-round-trip", 5))).resolves.toMatchObject({
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 2,
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
      await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION }),
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
    const canonical = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    test.setObject({ ...canonical, original: new TextEncoder().encode("foreign") });

    await expect(test.adapter.execute(operation("cleanup-exact", 6))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    expect(test.objects.remove).not.toHaveBeenCalled();
    expect(test.row()).toMatchObject({ rowCount: 1, phase: "row_claimed" });
  });

  it("recovers an upload response loss only after exact byte readback", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    vi.mocked(test.objects.upload).mockImplementationOnce(async () => {
      test.setObject(media);
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

  it("cleans an exact original after a definitive thumbnail upload failure", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    vi.mocked(test.objects.upload).mockImplementationOnce(async () => {
      test.setObject({ original: media.original });
      throw new ProductionSmokeOperationError("Storage thumbnail write failed");
    });

    await expect(test.adapter.execute(operation("write-object", 4))).rejects.toThrow(
      "Storage thumbnail write failed",
    );
    expect(test.row()).toMatchObject({ phase: "cleanup_pending", actionSequence: 4 });
    expect(test.objects.remove).toHaveBeenCalledTimes(1);
    await expect(test.adapter.execute(operation("cleanup-exact", 5))).resolves.toEqual({
      kind: "cleanup-finished",
    });
    expect(test.objects.remove).toHaveBeenCalledTimes(1);
    expect(test.row()).toEqual({ rowCount: 0 });
  });

  it.each(["object_write_pending", "object_written"] as const)(
    "refuses exact partial media cleanup while the persisted phase is %s",
    async (phase) => {
      const test = harness();
      await test.adapter.execute(operation("write-row", 3));
      const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
      test.setObject({ original: media.original });
      test.setPhase(phase, 4);

      await expect(test.adapter.execute(operation("cleanup-exact", 5))).rejects.toBeInstanceOf(
        ProductionSmokeOperationUncertainError,
      );
      expect(test.objects.remove).not.toHaveBeenCalled();
      expect(test.row()).toMatchObject({ phase, actionSequence: 4 });
    },
  );

  it("marks cleanup uncertain when post-delete Storage verification cannot complete", async () => {
    const test = harness();
    await test.adapter.execute(operation("write-row", 3));
    await test.adapter.execute(operation("write-object", 4));
    vi.mocked(test.objects.inspect)
      .mockImplementationOnce(async () => ({
        count: 2,
        canonical: true,
        identity: IDENTITY,
        generation: GENERATION,
        payloadSha256: HASH,
      }))
      .mockRejectedValueOnce(new ProductionSmokeOperationUncertainError("readback failed"));

    await expect(test.adapter.execute(operation("cleanup-exact", 5))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    expect(test.row()).toMatchObject({ phase: "cleanup_uncertain", actionSequence: 5 });
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
  it("uses only the fixed private original and thumbnail paths and verifies canonical bytes", async () => {
    const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    const files = {
      download: vi.fn((path: string) => ({
        asStream: vi.fn(async () => {
          const bytes = path.endsWith("original.png") ? media.original : media.thumbnail;
          return {
            data: new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]).stream(),
            error: null,
          };
        }),
      })),
      upload: vi.fn(async (path: string) => ({ data: { path }, error: null })),
      remove: vi.fn(async () => ({ data: [], error: null })),
    };
    const store = createSupabaseProductionSmokeObjectStore({
      supabaseUrl: "https://example.supabase.co",
      files,
    });

    await expect(store.inspect(media)).resolves.toMatchObject({
      count: 2,
      canonical: true,
      identity: IDENTITY,
      generation: GENERATION,
      payloadSha256: HASH,
    });
    await store.upload(media);
    await store.remove();
    expect(files.download).toHaveBeenCalledWith(
      "release-smoke-v1/original.png",
      expect.any(AbortSignal),
    );
    expect(files.download).toHaveBeenCalledWith(
      "release-smoke-v1/thumbnail.webp",
      expect.any(AbortSignal),
    );
    expect(files.upload).toHaveBeenCalledWith(
      "release-smoke-v1/original.png",
      media.original,
      { contentType: "image/png", upsert: false, cacheControl: "0" },
      expect.any(AbortSignal),
    );
    expect(files.upload).toHaveBeenCalledWith(
      "release-smoke-v1/thumbnail.webp",
      media.thumbnail,
      { contentType: "image/webp", upsert: false, cacheControl: "0" },
      expect.any(AbortSignal),
    );
    expect(files.remove).toHaveBeenCalledWith(
      ["release-smoke-v1/original.png", "release-smoke-v1/thumbnail.webp"],
      expect.any(AbortSignal),
    );
  });

  it("reports missing and oversized objects without exposing or deleting bytes", async () => {
    const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    let mode: "missing" | "oversized-original" = "missing";
    const download = vi.fn((path: string) => ({
      asStream: vi.fn(async () =>
        mode === "oversized-original" && path.endsWith("original.png")
          ? { data: new Blob([new ArrayBuffer(1025)]).stream(), error: null }
          : { data: null, error: { status: 404 } }),
    }));
    const store = createSupabaseProductionSmokeObjectStore({
      supabaseUrl: "https://example.supabase.co",
      files: {
        download,
        upload: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(store.inspect(media)).resolves.toEqual({ count: 0, canonical: false });
    mode = "oversized-original";
    await expect(store.inspect(media)).resolves.toEqual({ count: 1, canonical: false });
  });

  it("identifies a byte-exact partial upload so bounded failure cleanup can remove it", async () => {
    const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
    const store = createSupabaseProductionSmokeObjectStore({
      supabaseUrl: "https://example.supabase.co",
      files: {
        download: vi.fn((path: string) => ({
          asStream: vi.fn(async () => path.endsWith("original.png")
            ? {
                data: new Blob([new Uint8Array(media.original).buffer as ArrayBuffer]).stream(),
                error: null,
              }
            : { data: null, error: { status: 404 } }),
        })),
        upload: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(store.inspect(media)).resolves.toEqual({
      count: 1,
      canonical: true,
      identity: IDENTITY,
      generation: GENERATION,
      payloadSha256: HASH,
    });
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
      const media = await canonicalProductionSmokeMedia({ executionSha: SHA, generation: GENERATION });
      const assertion = expect(store.upload(media)).rejects.toBeInstanceOf(
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

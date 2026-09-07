import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type CanonicalProductionSmokeMedia,
  createPostgresProductionSmokeDatabase,
  ProductionSmokeCanaryAdapter,
  ProductionSmokeOperationUncertainError,
  type ProductionSmokeObjectStore,
} from "@/adapters/production-smoke-canary-adapter";
import { calculateProductionSmokePayloadSha256 } from "../../scripts/production-smoke-canary";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;
if (!directDatabaseUrl) throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");
const requiredDatabaseUrl: string = directDatabaseUrl;
const SHA = "a".repeat(40);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const PAYLOAD_SHA256 = calculateProductionSmokePayloadSha256(SHA);

function roleUrl(role: "app_runtime" | "app_migrator") {
  const url = new URL(requiredDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function operation(
  operationName: "inspect-baseline" | "run-fixed-read-checks" | "write-row" | "write-object" | "verify-round-trip" | "cleanup-exact" | "inspect-cleanup",
  actionSequence: number,
) {
  return { executionSha: SHA, generation: GENERATION, actionSequence, operation: operationName } as const;
}

const control = postgres(requiredDatabaseUrl, { max: 1, prepare: false });
let database: ReturnType<typeof createPostgresProductionSmokeDatabase>;
let objectMedia: CanonicalProductionSmokeMedia | undefined;
const objects: ProductionSmokeObjectStore = {
  async inspect(expected) {
    if (!objectMedia) return { count: 0, canonical: false };
    const sameBytes = (actual: Uint8Array, wanted: Uint8Array) =>
      actual.byteLength === wanted.byteLength &&
      actual.every((byte, index) => byte === wanted[index]);
    const canonical = sameBytes(objectMedia.original, expected.original) &&
      sameBytes(objectMedia.thumbnail, expected.thumbnail);
    return canonical
      ? { count: 2, canonical: true, identity: `release-smoke-v1:${SHA}`, generation: GENERATION, payloadSha256: PAYLOAD_SHA256 }
      : { count: 2, canonical: false };
  },
  async upload(media) { objectMedia = media; },
  async remove() { objectMedia = undefined; },
};

async function clearCanary() {
  objectMedia = undefined;
  await control.unsafe(`
    grant app_migrator to postgres;
    set local role app_migrator;
    delete from app_private.production_smoke_canaries;
    reset role;
  `);
}

beforeAll(async () => {
  await control.unsafe("grant app_runtime, app_migrator to postgres");
  database = createPostgresProductionSmokeDatabase(roleUrl("app_runtime"));
  await clearCanary();
});

afterEach(clearCanary);

afterAll(async () => {
  await database.close();
  await control.unsafe("revoke app_runtime, app_migrator from postgres");
  await control.end();
});

describe("Production smoke PostgreSQL adapter", () => {
  it("executes the complete fixed canary lifecycle through app_runtime functions", async () => {
    const adapter = new ProductionSmokeCanaryAdapter(database, objects);

    await expect(adapter.execute(operation("inspect-baseline", 1))).resolves.toMatchObject({ rowCount: 0, objectCount: 0 });
    await expect(adapter.execute(operation("run-fixed-read-checks", 2))).resolves.toMatchObject({
      checks: { "authenticated-library-read": "passed", "runtime-database-read": "passed" },
    });
    await expect(adapter.execute(operation("write-row", 3))).resolves.toEqual({ kind: "row-written" });
    await expect(adapter.execute(operation("write-object", 4))).resolves.toEqual({ kind: "object-written" });
    await expect(adapter.execute(operation("verify-round-trip", 5))).resolves.toMatchObject({
      rowCount: 1,
      objectCount: 2,
      rowPhase: "object_written",
    });
    await expect(adapter.execute(operation("cleanup-exact", 7))).resolves.toEqual({ kind: "cleanup-finished" });
    await expect(adapter.execute(operation("inspect-cleanup", 8))).resolves.toMatchObject({ rowCount: 0, objectCount: 0 });

    await expect(adapter.execute(operation("write-row", 3))).resolves.toEqual({ kind: "row-written" });
    await expect(adapter.execute(operation("write-object", 4))).resolves.toEqual({ kind: "object-written" });
    await expect(adapter.execute(operation("cleanup-exact", 7))).resolves.toEqual({ kind: "cleanup-finished" });
    await expect(adapter.execute(operation("inspect-cleanup", 8))).resolves.toMatchObject({ rowCount: 0, objectCount: 0 });
  });

  it("does not allow a stale same-generation cleanup to delete a later claim", async () => {
    const adapter = new ProductionSmokeCanaryAdapter(database, objects);
    await adapter.execute(operation("write-row", 3));
    await adapter.execute(operation("cleanup-exact", 4));
    await adapter.execute(operation("write-row", 6));

    await expect(adapter.execute(operation("cleanup-exact", 4))).rejects.toThrow("manual recovery");
    await expect(adapter.execute(operation("inspect-baseline", 7))).resolves.toMatchObject({
      rowCount: 1,
      rowGeneration: GENERATION,
      rowPhase: "row_claimed",
    });
  });

  it("commits object_write_uncertain before releasing a late Storage write", async () => {
    const uncertainObjects: ProductionSmokeObjectStore = {
      ...objects,
      async upload(media) {
        objectMedia = media;
        throw new ProductionSmokeOperationUncertainError("late upload");
      },
    };
    const adapter = new ProductionSmokeCanaryAdapter(database, uncertainObjects);
    await adapter.execute(operation("write-row", 3));

    await expect(adapter.execute(operation("write-object", 4))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    await expect(adapter.execute(operation("inspect-baseline", 5))).resolves.toMatchObject({
      rowCount: 1,
      objectCount: 2,
      rowPhase: "object_write_uncertain",
    });
  });

  it("commits cleanup_uncertain when Storage deletion loses its response", async () => {
    const adapter = new ProductionSmokeCanaryAdapter(database, objects);
    await adapter.execute(operation("write-row", 3));
    await adapter.execute(operation("write-object", 4));
    const uncertainCleanup = new ProductionSmokeCanaryAdapter(database, {
      ...objects,
      async remove() {
        objectMedia = undefined;
        throw new ProductionSmokeOperationUncertainError("late delete");
      },
    });

    await expect(uncertainCleanup.execute(operation("cleanup-exact", 6))).rejects.toBeInstanceOf(
      ProductionSmokeOperationUncertainError,
    );
    await expect(adapter.execute(operation("inspect-baseline", 7))).resolves.toMatchObject({
      rowCount: 1,
      objectCount: 0,
      rowPhase: "cleanup_uncertain",
    });
  });
});

import "server-only";

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import sharp from "sharp";

import {
  calculateProductionSmokePayloadSha256,
  PRODUCTION_SMOKE_NAMESPACE,
  PRODUCTION_SMOKE_OBJECT_PATH,
  PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH,
  type ProductionSmokePersistedPhase,
} from "../../scripts/production-smoke-canary";
import type {
  ReleaseSmokeOperationInput,
  ReleaseSmokeOperationResult,
} from "@/app/api/internal/release-smoke/handler";

const MAX_OBJECT_BYTES = 1024;
const STATEMENT_TIMEOUT_MS = 3_000;
const STORAGE_TIMEOUT_MS = 4_000;
const LOCK_KEY = "puizeru:production-smoke-canary:v1";

function isLocalDatabaseHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

export function createProductionSmokeSessionDatabaseUrl(databaseUrl: string) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ProductionSmokeOperationError("production smoke database URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ProductionSmokeOperationError("production smoke database URL is invalid");
  }
  if (isLocalDatabaseHost(url.hostname)) return url.toString();
  if (url.port !== "6543" && url.port !== "5432") {
    throw new ProductionSmokeOperationError("production smoke database must use a session-capable endpoint");
  }
  url.port = "5432";
  return url.toString();
}

type CanaryRow = Readonly<{
  rowCount: 0 | 1;
  identity?: string;
  generation?: string;
  actionSequence?: number;
  payloadSha256?: string;
  phase?: ProductionSmokePersistedPhase;
}>;

type ObjectSnapshot = Readonly<{
  count: 0 | 1 | 2;
  identity?: string;
  generation?: string;
  payloadSha256?: string;
  canonical: boolean;
}>;

export type ProductionSmokeDatabaseSession = Readonly<{
  inspect(): Promise<CanaryRow>;
  claim(input: Readonly<{ generation: string; identity: string; payloadSha256: string; actionSequence: number }>): Promise<boolean>;
  transition(input: Readonly<{
    generation: string;
    identity: string;
    payloadSha256: string;
    expectedActionSequence: number;
    expectedPhase: ProductionSmokePersistedPhase;
    nextActionSequence: number;
    nextPhase: ProductionSmokePersistedPhase;
  }>): Promise<boolean>;
  cleanup(input: Readonly<{
    generation: string;
    identity: string;
    payloadSha256: string;
    expectedActionSequence: number;
    expectedPhase: "row_claimed" | "cleanup_pending";
  }>): Promise<boolean>;
  probeRuntimeDatabase(): Promise<void>;
  probeLibraryReadable(): Promise<void>;
}>;

export type ProductionSmokeDatabase = Readonly<{
  locked<T>(callback: (session: ProductionSmokeDatabaseSession) => Promise<T>): Promise<T>;
  close(): Promise<void> | void;
}>;

export type ProductionSmokeObjectStore = Readonly<{
  inspect(expected: CanonicalProductionSmokeMedia, signal?: AbortSignal): Promise<ObjectSnapshot>;
  upload(canonical: CanonicalProductionSmokeMedia, signal?: AbortSignal): Promise<void>;
  remove(signal?: AbortSignal): Promise<void>;
}>;

export class ProductionSmokeOperationError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionSmokeOperationError: ${safeDetail}`);
    this.name = "ProductionSmokeOperationError";
  }
}

export class ProductionSmokeOperationUncertainError extends ProductionSmokeOperationError {
  constructor(safeDetail: string) {
    super(safeDetail);
    this.name = "ProductionSmokeOperationUncertainError";
  }
}

function identityFor(executionSha: string) {
  return `${PRODUCTION_SMOKE_NAMESPACE}:${executionSha}`;
}

export type CanonicalProductionSmokeMedia = Readonly<{
  identity: string;
  generation: string;
  payloadSha256: string;
  original: Uint8Array;
  thumbnail: Uint8Array;
}>;

export async function canonicalProductionSmokeMedia(input: Readonly<{
  executionSha: string;
  generation: string;
}>): Promise<CanonicalProductionSmokeMedia> {
  const identity = identityFor(input.executionSha);
  const payloadSha256 = calculateProductionSmokePayloadSha256(input.executionSha);
  const seed = createHash("sha256").update(JSON.stringify({
    namespace: PRODUCTION_SMOKE_NAMESPACE,
    identity,
    generation: input.generation,
    payloadSha256,
  })).digest();
  const pixels = Buffer.alloc(8 * 8 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = seed[offset % seed.length];
    pixels[offset + 1] = seed[(offset + 1) % seed.length];
    pixels[offset + 2] = seed[(offset + 2) % seed.length];
    pixels[offset + 3] = 255;
  }
  const original = new Uint8Array(await sharp(pixels, {
    raw: { width: 8, height: 8, channels: 4 },
  }).png().toBuffer());
  const thumbnail = new Uint8Array(await sharp(original)
    .resize(4, 4, { fit: "cover" })
    .webp()
    .toBuffer());
  if (original.byteLength > MAX_OBJECT_BYTES || thumbnail.byteLength > MAX_OBJECT_BYTES) {
    throw new ProductionSmokeOperationError("generated smoke media exceeds the bounded object size");
  }
  return { identity, generation: input.generation, payloadSha256, original, thumbnail };
}

function exactRow(row: CanaryRow, input: ReleaseSmokeOperationInput) {
  return row.rowCount === 1 &&
    row.identity === identityFor(input.executionSha) &&
    row.generation === input.generation &&
    row.payloadSha256 === calculateProductionSmokePayloadSha256(input.executionSha);
}

function countsEvent(
  purpose: "baseline" | "cleanup" | "round-trip",
  row: CanaryRow,
  object: ObjectSnapshot,
): ReleaseSmokeOperationResult {
  return {
    kind: purpose === "round-trip" ? "round-trip-observed" : "counts-observed",
    ...(purpose === "round-trip" ? {} : { purpose }),
    rowCount: row.rowCount,
    objectCount: object.count,
    ...(row.rowCount === 0 ? {} : {
      rowIdentity: row.identity,
      rowGeneration: row.generation,
      rowActionSequence: row.actionSequence,
      rowPayloadSha256: row.payloadSha256,
      rowPhase: row.phase,
    }),
    ...(object.count === 0 || !object.canonical ? {} : {
      objectIdentity: object.identity,
      objectGeneration: object.generation,
      objectPayloadSha256: object.payloadSha256,
    }),
  };
}

export class ProductionSmokeCanaryAdapter {
  constructor(
    private readonly database: ProductionSmokeDatabase,
    private readonly objects: ProductionSmokeObjectStore,
  ) {}

  async close() {
    await this.database.close();
  }

  async execute(
    input: ReleaseSmokeOperationInput,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ReleaseSmokeOperationResult> {
    const identity = identityFor(input.executionSha);
    const payloadSha256 = calculateProductionSmokePayloadSha256(input.executionSha);
    const canonical = await canonicalProductionSmokeMedia(input);

    return this.database.locked(async (session) => {
      switch (input.operation) {
        case "inspect-baseline":
        case "inspect-cleanup": {
          const [row, object] = await Promise.all([
            session.inspect(),
            this.objects.inspect(canonical, signal),
          ]);
          return countsEvent(
            input.operation === "inspect-baseline" ? "baseline" : "cleanup",
            row,
            object,
          );
        }
        case "run-fixed-read-checks":
          await session.probeRuntimeDatabase();
          await session.probeLibraryReadable();
          return {
            kind: "fixed-read-checks-observed",
            checks: {
              "authenticated-library-read": "passed",
              "runtime-database-read": "passed",
            },
          };
        case "write-row": {
          const claimed = await session.claim({
            generation: input.generation,
            identity,
            payloadSha256,
            actionSequence: input.actionSequence,
          });
          if (!claimed) {
            const row = await session.inspect();
            if (!exactRow(row, input) || row.phase !== "row_claimed" || row.actionSequence !== input.actionSequence) {
              throw new ProductionSmokeOperationError("fixed canary row is occupied by another action");
            }
          }
          return { kind: "row-written" };
        }
        case "write-object":
          return this.writeObject(session, input, canonical, identity, payloadSha256, signal);
        case "verify-round-trip": {
          const [row, object] = await Promise.all([
            session.inspect(),
            this.objects.inspect(canonical, signal),
          ]);
          return countsEvent("round-trip", row, object);
        }
        case "cleanup-exact":
          return this.cleanup(session, input, canonical, identity, payloadSha256, signal);
      }
    });
  }

  private async writeObject(
    session: ProductionSmokeDatabaseSession,
    input: ReleaseSmokeOperationInput,
    canonical: CanonicalProductionSmokeMedia,
    identity: string,
    payloadSha256: string,
    signal: AbortSignal,
  ): Promise<ReleaseSmokeOperationResult> {
    let row = await session.inspect();
    if (!exactRow(row, input) || row.actionSequence === undefined || row.phase === undefined) {
      throw new ProductionSmokeOperationError("canary row does not match the active write");
    }
    if (row.actionSequence > input.actionSequence) {
      throw new ProductionSmokeOperationError("canary action sequence is stale");
    }
    if (row.phase === "row_claimed") {
      const moved = await session.transition({
        generation: input.generation,
        identity,
        payloadSha256,
        expectedActionSequence: row.actionSequence,
        expectedPhase: "row_claimed",
        nextActionSequence: input.actionSequence,
        nextPhase: "object_write_pending",
      });
      if (!moved) throw new ProductionSmokeOperationError("canary write claim changed concurrently");
      row = { ...row, phase: "object_write_pending", actionSequence: input.actionSequence };
    }
    if (row.actionSequence !== input.actionSequence) {
      throw new ProductionSmokeOperationError("canary write action does not match persisted state");
    }
    if (row.phase === "object_written") {
      const existing = await this.objects.inspect(canonical, signal);
      if (existing.count === 2 && existing.canonical) return { kind: "object-written" };
      throw new ProductionSmokeOperationError("persisted object write does not match Storage");
    }
    if (row.phase !== "object_write_pending") {
      throw new ProductionSmokeOperationError("canary row is not writable");
    }

    try {
      await this.objects.upload(canonical, signal);
      const stored = await this.objects.inspect(canonical, signal);
      if (stored.count !== 2 || !stored.canonical) {
        throw new ProductionSmokeOperationUncertainError("Storage write could not be verified exactly");
      }
      const moved = await session.transition({
        generation: input.generation,
        identity,
        payloadSha256,
        expectedActionSequence: input.actionSequence,
        expectedPhase: "object_write_pending",
        nextActionSequence: input.actionSequence,
        nextPhase: "object_written",
      });
      if (!moved) throw new ProductionSmokeOperationUncertainError("Storage write completed after the DB fence changed");
      return { kind: "object-written" };
    } catch (error) {
      let nextPhase: "object_write_uncertain" | "cleanup_pending" =
        error instanceof ProductionSmokeOperationUncertainError
          ? "object_write_uncertain"
          : "cleanup_pending";
      if (nextPhase === "cleanup_pending") {
        try {
          const observed = await this.objects.inspect(canonical, signal);
          if (observed.count === 2 && observed.canonical) {
            const moved = await session.transition({
              generation: input.generation,
              identity,
              payloadSha256,
              expectedActionSequence: input.actionSequence,
              expectedPhase: "object_write_pending",
              nextActionSequence: input.actionSequence,
              nextPhase: "object_written",
            });
            if (!moved) throw new ProductionSmokeOperationUncertainError("recovered Storage write lost its DB fence");
            return { kind: "object-written" };
          }
          if (observed.count === 1 && observed.canonical) {
            try {
              await this.objects.remove(signal);
              const afterDelete = await this.objects.inspect(canonical, signal);
              if (afterDelete.count !== 0) {
                throw new ProductionSmokeOperationUncertainError(
                  "partial Storage write cleanup could not be verified",
                );
              }
            } catch {
              nextPhase = "object_write_uncertain";
            }
          }
          if (observed.count > 0 && !observed.canonical) {
            nextPhase = "object_write_uncertain";
          }
        } catch {
          nextPhase = "object_write_uncertain";
        }
      }
      const recorded = await session.transition({
        generation: input.generation,
        identity,
        payloadSha256,
        expectedActionSequence: input.actionSequence,
        expectedPhase: "object_write_pending",
        nextActionSequence: input.actionSequence,
        nextPhase,
      });
      if (!recorded || nextPhase === "object_write_uncertain") {
        throw new ProductionSmokeOperationUncertainError("Storage write outcome is uncertain");
      }
      throw error;
    }
  }

  private async cleanup(
    session: ProductionSmokeDatabaseSession,
    input: ReleaseSmokeOperationInput,
    canonical: CanonicalProductionSmokeMedia,
    identity: string,
    payloadSha256: string,
    signal: AbortSignal,
  ): Promise<ReleaseSmokeOperationResult> {
    let row = await session.inspect();
    if (row.rowCount === 0) {
      const object = await this.objects.inspect(canonical, signal);
      if (object.count === 0) return { kind: "cleanup-finished" };
      throw new ProductionSmokeOperationUncertainError("Storage object exists without its canary row");
    }
    if (!exactRow(row, input) || row.actionSequence === undefined || row.phase === undefined) {
      throw new ProductionSmokeOperationError("canary row does not match exact cleanup");
    }
    if (row.actionSequence > input.actionSequence || row.phase.endsWith("_uncertain")) {
      throw new ProductionSmokeOperationUncertainError("canary cleanup state requires manual recovery");
    }
    const object = await this.objects.inspect(canonical, signal);
    if (object.count > 0 && !object.canonical) {
      throw new ProductionSmokeOperationUncertainError("fixed Storage media objects are incomplete or not the active canary");
    }
    if (object.count === 1) {
      throw new ProductionSmokeOperationUncertainError(
        "partial Storage media from an interrupted cleanup requires manual recovery",
      );
    }

    if (row.phase === "object_written" || row.phase === "object_write_pending") {
      const moved = await session.transition({
        generation: input.generation,
        identity,
        payloadSha256,
        expectedActionSequence: row.actionSequence,
        expectedPhase: row.phase,
        nextActionSequence: input.actionSequence,
        nextPhase: "cleanup_pending",
      });
      if (!moved) throw new ProductionSmokeOperationError("canary cleanup claim changed concurrently");
      row = { ...row, phase: "cleanup_pending", actionSequence: input.actionSequence };
    }
    if (row.phase === "row_claimed" && object.count !== 0) {
      throw new ProductionSmokeOperationUncertainError("uncommitted Storage object prevents row-only cleanup");
    }
    if (row.phase !== "row_claimed" && row.phase !== "cleanup_pending") {
      throw new ProductionSmokeOperationError("canary phase is not eligible for cleanup");
    }
    const cleanupActionSequence = row.actionSequence;
    if (cleanupActionSequence === undefined) {
      throw new ProductionSmokeOperationError("canary cleanup sequence is missing");
    }
    if (object.count > 0) {
      try {
        await this.objects.remove(signal);
        const afterDelete = await this.objects.inspect(canonical, signal);
        if (afterDelete.count !== 0) {
          throw new ProductionSmokeOperationUncertainError("Storage cleanup could not be verified");
        }
      } catch {
        await session.transition({
          generation: input.generation,
          identity,
          payloadSha256,
          expectedActionSequence: cleanupActionSequence,
          expectedPhase: "cleanup_pending",
          nextActionSequence: input.actionSequence,
          nextPhase: "cleanup_uncertain",
        });
        throw new ProductionSmokeOperationUncertainError("Storage cleanup outcome is uncertain");
      }
    }
    const removed = await session.cleanup({
      generation: input.generation,
      identity,
      payloadSha256,
      expectedActionSequence: cleanupActionSequence,
      expectedPhase: row.phase,
    });
    if (!removed) throw new ProductionSmokeOperationUncertainError("database cleanup fence changed");
    return { kind: "cleanup-finished" };
  }
}

type UnsafeSql = <T extends Record<string, unknown>[]>(query: string, parameters?: unknown[]) => Promise<T>;

function postgresSession(unsafe: UnsafeSql): ProductionSmokeDatabaseSession {
  const inspect = async (): Promise<CanaryRow> => {
    const rows = await unsafe<Array<Record<string, unknown>>>(
      "select * from app_private.inspect_production_smoke_canary()",
    );
    const row = rows[0];
    const rowCount = typeof row?.row_count === "bigint" || typeof row?.row_count === "string"
      ? Number(row.row_count)
      : row?.row_count;
    if (!row || (rowCount !== 0 && rowCount !== 1)) {
      throw new ProductionSmokeOperationError("database inspect result is invalid");
    }
    return rowCount === 0 ? { rowCount: 0 } : {
      rowCount: 1,
      identity: row.identity as string,
      generation: row.generation as string,
      actionSequence: Number(row.action_sequence),
      payloadSha256: row.payload_sha256 as string,
      phase: row.phase as ProductionSmokePersistedPhase,
    };
  };
  return {
    inspect,
    async claim(input) {
      const rows = await unsafe<Array<{ claimed: boolean }>>(
        "select app_private.claim_production_smoke_canary($1,$2,$3,$4) as claimed",
        [input.generation, input.identity, input.payloadSha256, input.actionSequence],
      );
      return rows[0]?.claimed === true;
    },
    async transition(input) {
      const rows = await unsafe<Array<{ transitioned: boolean }>>(
        "select app_private.transition_production_smoke_canary($1,$2,$3,$4,$5,$6,$7) as transitioned",
        [input.generation, input.identity, input.payloadSha256, input.expectedActionSequence, input.expectedPhase, input.nextActionSequence, input.nextPhase],
      );
      return rows[0]?.transitioned === true;
    },
    async cleanup(input) {
      const rows = await unsafe<Array<{ cleaned: boolean }>>(
        "select app_private.cleanup_production_smoke_canary($1,$2,$3,$4,$5) as cleaned",
        [input.generation, input.identity, input.payloadSha256, input.expectedActionSequence, input.expectedPhase],
      );
      return rows[0]?.cleaned === true;
    },
    async probeRuntimeDatabase() {
      const rows = await unsafe<Array<{ probe: number }>>("select 1::integer as probe");
      if (rows[0]?.probe !== 1) throw new ProductionSmokeOperationError("runtime database probe failed");
    },
    async probeLibraryReadable() {
      const rows = await unsafe<Array<{ readable: boolean }>>(
        "select exists(select 1 from app_private.games limit 1) as readable",
      );
      if (typeof rows[0]?.readable !== "boolean") throw new ProductionSmokeOperationError("library read probe failed");
    },
  };
}

export function createPostgresProductionSmokeDatabase(databaseUrl: string): ProductionSmokeDatabase {
  const sessionDatabaseUrl = createProductionSmokeSessionDatabaseUrl(databaseUrl);
  const parsedUrl = new URL(sessionDatabaseUrl);
  if (!isLocalDatabaseHost(parsedUrl.hostname) && parsedUrl.port !== "5432") {
    throw new ProductionSmokeOperationError("production smoke database must use a session-capable endpoint");
  }
  const client = postgres(sessionDatabaseUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  return {
    async locked<T>(callback: (session: ProductionSmokeDatabaseSession) => Promise<T>) {
      const connection = await client.reserve();
      let locked = false;
      try {
        await connection.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
        const locks = await connection.unsafe<Array<{ locked: boolean }>>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [LOCK_KEY],
        );
        if (locks[0]?.locked !== true) throw new ProductionSmokeOperationError("canary operation lock is busy");
        locked = true;
        // Each SECURITY DEFINER function is its own committed statement. The
        // session lock spans those commits and the Storage call, so pending and
        // uncertain fences survive an adapter error.
        return await callback(postgresSession(connection.unsafe.bind(connection) as UnsafeSql));
      } finally {
        try {
          if (locked) {
            await connection.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY]);
          }
          await connection.unsafe("reset statement_timeout");
        } finally {
          connection.release();
        }
      }
    },
    close: () => client.end({ timeout: 1 }),
  };
}

type StorageFiles = Readonly<{
  download(path: string, signal: AbortSignal): Readonly<{
    asStream(): Promise<Readonly<{ data: ReadableStream<Uint8Array> | null; error: unknown }>>;
  }>;
  upload(path: string, body: Uint8Array, options: Readonly<{ contentType: string; upsert: false; cacheControl: string }>, signal: AbortSignal): Promise<Readonly<{ data: unknown; error: unknown }>>;
  remove(paths: string[], signal: AbortSignal): Promise<Readonly<{ data: unknown; error: unknown }>>;
}>;

function notFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.status === 404 || value.statusCode === "404" || value.code === "404";
}

async function withStorageDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProductionSmokeOperationUncertainError("Storage deadline exceeded"));
        }, STORAGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_OBJECT_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new ProductionSmokeOperationUncertainError("Storage deadline exceeded");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createSupabaseProductionSmokeObjectStore(input: Readonly<{
  supabaseUrl: string;
  secretKey?: string;
  files?: StorageFiles;
}>): ProductionSmokeObjectStore {
  if (!input.files && !input.secretKey) throw new ProductionSmokeOperationError("Storage credentials are unavailable");
  const files = input.files ?? {
    download(path: string, signal: AbortSignal) {
      const bucket = createClient(input.supabaseUrl, input.secretKey as string, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (request, init) => fetch(request, { ...init, signal }) },
      }).storage.from("game-media");
      return { asStream: () => bucket.download(path).asStream() };
    },
    upload(path: string, body: Uint8Array, options: Readonly<{ contentType: string; upsert: false; cacheControl: string }>, signal: AbortSignal) {
      return createClient(input.supabaseUrl, input.secretKey as string, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (request, init) => fetch(request, { ...init, signal }) },
      }).storage.from("game-media").upload(path, body, options);
    },
    remove(paths: string[], signal: AbortSignal) {
      return createClient(input.supabaseUrl, input.secretKey as string, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (request, init) => fetch(request, { ...init, signal }) },
      }).storage.from("game-media").remove(paths);
    },
  } as unknown as StorageFiles;
  return {
    async inspect(expected, parentSignal) {
      try {
        const inspectPath = async (path: string, expectedBytes: Uint8Array) => {
          const { data, error, bytes } = await withStorageDeadline(async (signal) => {
            const { data, error } = await files.download(path, signal).asStream();
            return {
              data,
              error,
              bytes: data ? await readBoundedStream(data, signal) : undefined,
            };
          }, parentSignal);
          if (error) {
            if (notFound(error)) return { exists: false, canonical: false };
            throw new ProductionSmokeOperationUncertainError("Storage inspect failed");
          }
          if (!data || !bytes) return { exists: true, canonical: false };
          return {
            exists: true,
            canonical: bytes.byteLength === expectedBytes.byteLength &&
              bytes.every((byte, index) => byte === expectedBytes[index]),
          };
        };
        const [original, thumbnail] = await Promise.all([
          inspectPath(PRODUCTION_SMOKE_OBJECT_PATH, expected.original),
          inspectPath(PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH, expected.thumbnail),
        ]);
        const count = (Number(original.exists) + Number(thumbnail.exists)) as 0 | 1 | 2;
        const canonical = count > 0 &&
          (!original.exists || original.canonical) &&
          (!thumbnail.exists || thumbnail.canonical);
        if (!canonical) return { count, canonical: false };
        return {
          count,
          canonical: true,
          identity: expected.identity,
          generation: expected.generation,
          payloadSha256: expected.payloadSha256,
        };
      } catch (error) {
        if (error instanceof ProductionSmokeOperationUncertainError) throw error;
        throw new ProductionSmokeOperationUncertainError("Storage inspect failed");
      }
    },
    async upload(canonical, parentSignal) {
      try {
        const original = await withStorageDeadline((signal) => files.upload(
          PRODUCTION_SMOKE_OBJECT_PATH,
          canonical.original,
          { contentType: "image/png", upsert: false, cacheControl: "0" },
          signal,
        ), parentSignal);
        if (original.error) throw new ProductionSmokeOperationError("Storage original write failed");
        const thumbnail = await withStorageDeadline((signal) => files.upload(
          PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH,
          canonical.thumbnail,
          { contentType: "image/webp", upsert: false, cacheControl: "0" },
          signal,
        ), parentSignal);
        if (thumbnail.error) throw new ProductionSmokeOperationError("Storage thumbnail write failed");
      } catch (error) {
        if (error instanceof ProductionSmokeOperationError) throw error;
        throw new ProductionSmokeOperationUncertainError("Storage write failed without a response");
      }
    },
    async remove(parentSignal) {
      try {
        const { error } = await withStorageDeadline(
          (signal) => files.remove([
            PRODUCTION_SMOKE_OBJECT_PATH,
            PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH,
          ], signal),
          parentSignal,
        );
        if (error && !notFound(error)) throw new ProductionSmokeOperationUncertainError("Storage delete failed");
      } catch (error) {
        if (error instanceof ProductionSmokeOperationUncertainError) throw error;
        throw new ProductionSmokeOperationUncertainError("Storage delete failed without a response");
      }
    },
  };
}

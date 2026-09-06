import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDatabase } from "@/adapters/database";
import { PostgresMediaStore } from "@/adapters/postgres-media-store";
import {
  MediaStoredObjectInvalidError,
  MediaUploadIdempotencyConflictError,
  createMediaService,
  type MediaObjectStore,
} from "@/modules/media";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const gameId = "51000000-0000-4000-8000-000000000001";
const key = "52000000-0000-4000-8000-000000000001";
const owner = { sub: "owner-subject" };
const options = { max: 1, prepare: false } as const;

function roleUrl(role: "app_runtime" | "app_migrator"): string {
  const url = new URL(directDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function png(): Uint8Array {
  const crc32 = (input: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Uint8Array) => {
    const result = new Uint8Array(12 + data.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(new TextEncoder().encode(name), 4);
    result.set(data, 8);
    view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
    return result;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 20);
  new DataView(ihdr.buffer).setUint32(4, 30);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function objects(bytes = png(), mimeType = "image/png"): MediaObjectStore {
  return {
    async createUploadGrant(path) { return { token: `token:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }; },
    async inspect(path) { return { path, byteSize: bytes.byteLength, mimeType }; },
    async *read() { yield bytes; },
  };
}

let control: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;
let database: ReturnType<typeof createDatabase>;

async function clean(): Promise<void> {
  await runtime.unsafe("update app_private.games set manual_cover_asset_id = null where id = $1", [gameId]);
  await runtime.unsafe("delete from app_private.media_derivative_attempts where derivative_id in (select id from app_private.media_derivatives where asset_id in (select id from app_private.media_assets where game_id = $1))", [gameId]);
  await runtime.unsafe("delete from app_private.media_derivatives where asset_id in (select id from app_private.media_assets where game_id = $1)", [gameId]);
  await runtime.unsafe("delete from app_private.media_assets where game_id = $1", [gameId]);
  await runtime.unsafe("delete from app_private.media_ingests where game_id = $1", [gameId]);
  await runtime.unsafe("delete from app_private.games where id = $1", [gameId]);
}

beforeAll(async () => {
  control = postgres(directDatabaseUrl, options);
  await control.unsafe("grant app_runtime to postgres");
  runtime = postgres(roleUrl("app_runtime"), { ...options, max: 5 });
  database = createDatabase(roleUrl("app_runtime"));
});

beforeEach(async () => {
  await clean();
  await runtime.unsafe("insert into app_private.games (id, medium, display_name) values ($1, 'board_game', '媒體整合測試')", [gameId]);
});

afterAll(async () => {
  await clean();
  await database.close();
  await runtime.end();
  await control.unsafe("revoke app_runtime from postgres");
  await control.end();
});

function serviceFor(storage = objects()) {
  return createMediaService({ store: new PostgresMediaStore(database.db), objects: storage });
}

function beginCommand(overrides: Partial<Readonly<{ idempotencyKey: string; purpose: "gallery_image" | "custom_cover" | "attachment"; declaredMimeType: string; declaredByteSize: number; originalFileName: string }>> = {}) {
  return { idempotencyKey: key, gameId, purpose: "gallery_image" as const, declaredMimeType: "image/png", declaredByteSize: png().byteLength, originalFileName: "photo.png", ...overrides };
}

describe("MediaService 與真 PostgreSQL", () => {
  it("並行 begin 只保留同一 ingest、asset 與 object path，參數漂移具名失敗", async () => {
    const service = serviceFor();
    const [first, second] = await Promise.all([
      service.beginMediaUpload(owner, beginCommand()),
      service.beginMediaUpload(owner, beginCommand()),
    ]);

    expect(second).toEqual(first);
    const counts = await runtime.unsafe<{ ingest_count: number }[]>("select count(*)::int as ingest_count from app_private.media_ingests where idempotency_key = $1", [key]);
    expect(counts[0].ingest_count).toBe(1);
    await expect(service.beginMediaUpload(owner, beginCommand({ purpose: "attachment" })))
      .rejects.toBeInstanceOf(MediaUploadIdempotencyConflictError);
  });

  it("finalize 建立單一 asset 與 pending derivative，回應遺失後重播同一結果", async () => {
    const service = serviceFor();
    const grant = await service.beginMediaUpload(owner, beginCommand({ purpose: "custom_cover" }));

    const first = await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const replay = await service.finalizeMediaUpload(owner, { idempotencyKey: key });

    expect(replay).toEqual(first);
    expect(first.asset.id).toBe(grant.assetId);
    const rows = await runtime.unsafe<{ asset_count: number; derivative_count: number; manual_cover_asset_id: string }[]>(`
      select
        (select count(*)::int from app_private.media_assets where ingest_id = $1) as asset_count,
        (select count(*)::int from app_private.media_derivatives where asset_id = $2) as derivative_count,
        manual_cover_asset_id
      from app_private.games where id = $3
    `, [grant.ingestId, grant.assetId, gameId]);
    expect(rows[0]).toEqual({ asset_count: 1, derivative_count: 1, manual_cover_asset_id: grant.assetId });
  });

  it("實際大小或 MIME 不符時轉 cleanup_pending，且不建立 asset", async () => {
    const service = serviceFor(objects(png(), "image/jpeg"));
    await service.beginMediaUpload(owner, beginCommand());

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey: key }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);

    const rows = await runtime.unsafe<{ state: string; asset_count: number }[]>(`
      select state, (select count(*)::int from app_private.media_assets where ingest_id = media_ingests.id) as asset_count
      from app_private.media_ingests where idempotency_key = $1
    `, [key]);
    expect(rows[0]).toEqual({ state: "cleanup_pending", asset_count: 0 });
  });
});

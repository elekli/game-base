import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import sharp from "sharp";
import { createDatabase } from "@/adapters/database";
import { PostgresMediaStore } from "@/adapters/postgres-media-store";
import {
  MediaAssetUnavailableError,
  MediaStoredObjectInvalidError,
  MediaFinalizeUnavailableError,
  MediaStorageUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
  type BeginMediaUploadResult,
  type FinalizeMediaUploadResult,
  type MediaUploadResult,
} from "@/modules/media";
import { createMediaService } from "@/modules/media/internal/create-media-service";
import type { MediaObjectStore } from "@/modules/media/internal/types";
import type { MediaStore } from "@/modules/media/internal/types";

function grantFrom(result: BeginMediaUploadResult) {
  if (result.status !== "upload_grant") throw new Error("expected upload grant");
  return result;
}

function finalizedFrom(result: FinalizeMediaUploadResult): MediaUploadResult {
  if ("status" in result) throw new Error("expected finalized upload");
  return result;
}

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
let gameId: string;
let key: string;
const owner = { sub: "owner-subject" };
const options = { max: 1, prepare: false } as const;

function roleUrl(role: "app_runtime" | "app_migrator"): string {
  const url = new URL(directDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function namedRoleUrl(role: "app_runtime", applicationName: string): string {
  const url = new URL(roleUrl(role));
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<Value>(promise: Promise<Value>, milliseconds = 2_000): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForDatabaseLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await control.unsafe<{ blocked: boolean }[]>(`
      select exists (
        select 1 from pg_stat_activity
        where application_name = $1 and state = 'active' and wait_event_type = 'Lock'
      ) as blocked
    `, [applicationName]);
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`database operation ${applicationName} did not block on the expected lock`);
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
    async createUploadGrant(path) { return { uploadUrl: `https://storage.example.test/upload/${encodeURIComponent(path)}`, token: `token:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }; },
    async createOriginalReadGrant(path, fileName) { return { url: `https://storage.example.test/${encodeURIComponent(path)}?download=${encodeURIComponent(fileName)}`, expiresAt: "2026-09-06T00:01:00.000Z" }; },
    async inspect(path) { return { path, byteSize: bytes.byteLength, mimeType }; },
    async *read() { yield bytes; },
    async uploadDerivative() {},
  };
}

let control: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  control = postgres(directDatabaseUrl, options);
  await control.unsafe("grant app_runtime to postgres");
  runtime = postgres(roleUrl("app_runtime"), { ...options, max: 5 });
  database = createDatabase(roleUrl("app_runtime"));
});

beforeEach(async () => {
  gameId = crypto.randomUUID();
  key = crypto.randomUUID();
  await runtime.unsafe("insert into app_private.games (id, medium, display_name) values ($1, 'board_game', '媒體整合測試')", [gameId]);
});

afterEach(async () => {
  await runtime.unsafe("update app_private.games set trashed_at = now() where id = $1", [gameId]);
});

afterAll(async () => {
  await database.close();
  await runtime.end();
  await control.end();
});

function serviceFor(storage = objects()) {
  return createMediaService({ store: new PostgresMediaStore(database.db), objects: storage });
}

function beginCommand(overrides: Partial<Readonly<{ idempotencyKey: string; purpose: "gallery_image" | "custom_cover" | "attachment"; declaredMimeType: string; declaredByteSize: number; originalFileName: string }>> = {}) {
  return { idempotencyKey: key, gameId, purpose: "gallery_image" as const, declaredMimeType: "image/png", declaredByteSize: png().byteLength, originalFileName: "photo.png", ...overrides };
}

describe("MediaService 與真 PostgreSQL", () => {
  it("只有 finalized、active 且遊戲未移除的 asset 可重發 original read", async () => {
    const service = serviceFor();
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });

    await expect(service.issueOriginalRead(owner, { assetId: grant.assetId })).resolves.toMatchObject({
      status: "original_read", disposition: "attachment", url: expect.stringContaining("download="),
    });
    await runtime.unsafe("update app_private.media_assets set removed_at = now(), removed_reason = 'owner_removed' where id = $1", [grant.assetId]);
    await expect(service.issueOriginalRead(owner, { assetId: grant.assetId })).rejects.toBeInstanceOf(MediaAssetUnavailableError);
  });

  it("trash 先取得遊戲列鎖時，公開 begin 等待提交後拒絕且不留下 ingest", async () => {
    const applicationName = "media_begin_trash_race";
    const raceDatabase = createDatabase(namedRoleUrl("app_runtime", applicationName));
    const raceService = createMediaService({ store: new PostgresMediaStore(raceDatabase.db), objects: objects() });
    const trashed = deferred();
    const releaseTrash = deferred();
    const trash = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.games set trashed_at = now() where id = $1", [gameId]);
      trashed.resolve();
      await releaseTrash.promise;
    });

    try {
      await trashed.promise;
      const beginOutcome = raceService.beginMediaUpload(owner, beginCommand()).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForDatabaseLock(applicationName);
      releaseTrash.resolve();
      await trash;

      const outcome = await beginOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(MediaGameUnavailableError);
      const rows = await control.unsafe<{ ingest_count: number; operation_count: number }[]>(`
        select
          (select count(*)::int from app_private.media_ingests where idempotency_key = $1) as ingest_count,
          (select count(*)::int from app_private.media_ingest_operations where idempotency_key = $1) as operation_count
      `, [key]);
      expect(rows[0]).toEqual({ ingest_count: 0, operation_count: 0 });
    } finally {
      releaseTrash.resolve();
      await trash.catch(() => undefined);
      await raceDatabase.close();
    }
  });

  it("資產移除先鎖定時，人工封面指標等待後不得指向已移除資產", async () => {
    const grant = grantFrom(await serviceFor().beginMediaUpload(owner, beginCommand({ purpose: "custom_cover" })));
    await serviceFor().finalizeMediaUpload(owner, { idempotencyKey: key });
    await runtime.unsafe("update app_private.games set manual_cover_asset_id = null where id = $1", [gameId]);
    const pointerApplication = "media_pointer_after_remove";
    const pointer = postgres(namedRoleUrl("app_runtime", pointerApplication), options);
    const removed = deferred();
    const releaseRemoval = deferred();
    const removal = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.media_assets set removed_at = now(), removed_reason = 'owner_removed' where id = $1", [grant.assetId]);
      removed.resolve();
      await releaseRemoval.promise;
    });

    try {
      await removed.promise;
      const pointerOutcome = pointer.unsafe("update app_private.games set manual_cover_asset_id = $1 where id = $2", [grant.assetId, gameId]).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForDatabaseLock(pointerApplication);
      releaseRemoval.resolve();
      await removal;

      const outcome = await pointerOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("media manual cover must reference an active image from the same game");
      const rows = await control.unsafe<{ manual_cover_asset_id: string | null; removed: boolean }[]>(`
        select game.manual_cover_asset_id, asset.removed_at is not null as removed
        from app_private.games game join app_private.media_assets asset on asset.id = $1
        where game.id = $2
      `, [grant.assetId, gameId]);
      expect(rows[0]).toEqual({ manual_cover_asset_id: null, removed: true });
    } finally {
      releaseRemoval.resolve();
      await removal.catch(() => undefined);
      await pointer.end();
    }
  });

  it("人工封面指標先鎖定資產時，反向移除等待後不得破壞指標", async () => {
    const grant = grantFrom(await serviceFor().beginMediaUpload(owner, beginCommand({ purpose: "custom_cover" })));
    await serviceFor().finalizeMediaUpload(owner, { idempotencyKey: key });
    await runtime.unsafe("update app_private.games set manual_cover_asset_id = null where id = $1", [gameId]);
    const removalApplication = "media_remove_after_pointer";
    const removal = postgres(namedRoleUrl("app_runtime", removalApplication), options);
    const pointed = deferred();
    const releasePointer = deferred();
    const pointer = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.games set manual_cover_asset_id = $1 where id = $2", [grant.assetId, gameId]);
      pointed.resolve();
      await releasePointer.promise;
    });

    try {
      await pointed.promise;
      const removalOutcome = removal.unsafe("update app_private.media_assets set removed_at = now(), removed_reason = 'owner_removed' where id = $1", [grant.assetId]).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForDatabaseLock(removalApplication);
      releasePointer.resolve();
      await pointer;

      const outcome = await removalOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("media manual cover must reference an active image from the same game");
      const rows = await control.unsafe<{ manual_cover_asset_id: string | null; removed: boolean }[]>(`
        select game.manual_cover_asset_id, asset.removed_at is not null as removed
        from app_private.games game join app_private.media_assets asset on asset.id = $1
        where game.id = $2
      `, [grant.assetId, gameId]);
      expect(rows[0]).toEqual({ manual_cover_asset_id: grant.assetId, removed: false });
    } finally {
      releasePointer.resolve();
      await pointer.catch(() => undefined);
      await removal.end();
    }
  });

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
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand({ purpose: "custom_cover" })));

    const first = finalizedFrom(await service.finalizeMediaUpload(owner, { idempotencyKey: key }));
    const replay = finalizedFrom(await service.finalizeMediaUpload(owner, { idempotencyKey: key }));
    const beginReplay = await service.beginMediaUpload(owner, beginCommand({ purpose: "custom_cover" }));

    expect(replay).toEqual(first);
    expect(beginReplay).toEqual({ status: "already_finalized", result: first });
    expect(first.asset.id).toBe(grant.assetId);
    const rows = await runtime.unsafe<{ asset_count: number; derivative_count: number; manual_cover_asset_id: string }[]>(`
      select
        (select count(*)::int from app_private.media_assets where ingest_id = $1) as asset_count,
        (select count(*)::int from app_private.media_derivatives where asset_id = $2) as derivative_count,
        manual_cover_asset_id
      from app_private.games where id = $3
    `, [grant.ingestId, grant.assetId, gameId]);
    expect(rows[0]).toEqual({ asset_count: 1, derivative_count: 1, manual_cover_asset_id: grant.assetId });
    await expect(runtime.unsafe("update app_private.media_derivatives set spec = null where asset_id = $1", [grant.assetId]))
      .rejects.toThrow("verified media derivative identity fields are immutable");
    await expect(runtime.unsafe("update app_private.media_derivatives set authority_state = 'legacy_unverified' where asset_id = $1", [grant.assetId]))
      .rejects.toThrow("verified media derivative identity fields are immutable");
    await expect(runtime.unsafe("delete from app_private.media_derivatives where asset_id = $1", [grant.assetId]))
      .rejects.toThrow("cannot delete verified image derivative");
  });

  it("同鍵 finalize 已在驗證物件時，並行呼叫回報 finalizing，完成後重播同一資產", async () => {
    const inspectStarted = deferred();
    const releaseInspect = deferred();
    let inspectCount = 0;
    let readCount = 0;
    const bytes = png();
    const storage: MediaObjectStore = {
      async createUploadGrant(path) { return { uploadUrl: `https://storage.example.test/upload/${encodeURIComponent(path)}`, token: `token:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }; },
      async createOriginalReadGrant(path, fileName) { return { url: `https://storage.example.test/${encodeURIComponent(path)}?download=${encodeURIComponent(fileName)}`, expiresAt: "2026-09-06T00:01:00.000Z" }; },
      async inspect(path) {
        inspectCount += 1;
        inspectStarted.resolve();
        await releaseInspect.promise;
        return { path, byteSize: bytes.byteLength, mimeType: "image/png" };
      },
      async *read() { readCount += 1; yield bytes; },
      async uploadDerivative() {},
    };
    const service = serviceFor(storage);
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));

    const firstFinalize = service.finalizeMediaUpload(owner, { idempotencyKey: key });
    try {
      await within(inspectStarted.promise);
      const concurrent = await within(service.finalizeMediaUpload(owner, { idempotencyKey: key }));

      expect(concurrent).toEqual({ status: "finalizing" });
      expect({ inspectCount, readCount }).toEqual({ inspectCount: 1, readCount: 0 });
    } finally {
      releaseInspect.resolve();
    }

    const first = finalizedFrom(await within(firstFinalize));
    const replay = finalizedFrom(await within(service.finalizeMediaUpload(owner, { idempotencyKey: key })));
    expect(first.asset.id).toBe(grant.assetId);
    expect(replay).toEqual(first);
    expect({ inspectCount, readCount }).toEqual({ inspectCount: 1, readCount: 1 });
  });

  it("PostgreSQL 時鐘判定 lease 過期後拒絕舊 token 完成", async () => {
    const store = new PostgresMediaStore(database.db);
    const service = createMediaService({ store, objects: objects() });
    await service.beginMediaUpload(owner, beginCommand());
    const leaseToken = "53000000-0000-4000-8000-000000000001";
    await store.claimFinalize(key, { token: leaseToken, until: "2000-01-01T00:00:00.000Z" });

    await expect(store.completeFinalize(key, leaseToken, {
      actualMimeType: "image/png", byteSize: png().byteLength, width: 20, height: 30,
    })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
  });

  it("PostgreSQL 時鐘拒絕過期 worker release incomplete", async () => {
    const store = new PostgresMediaStore(database.db);
    await serviceFor().beginMediaUpload(owner, beginCommand());
    const token = "53000000-0000-4000-8000-000000000002";
    await store.claimFinalize(key, { token, until: "2000-01-01T00:00:00.000Z" });
    await expect(store.releaseIncomplete(key, token)).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    const rows = await runtime.unsafe<{ state: string }[]>("select state from app_private.media_ingests where idempotency_key = $1", [key]);
    expect(rows[0].state).toBe("finalizing");
  });

  it("舊 token 被新 worker 取代後不得 reject invalid", async () => {
    const store = new PostgresMediaStore(database.db);
    await serviceFor().beginMediaUpload(owner, beginCommand());
    const oldToken = "53000000-0000-4000-8000-000000000003";
    const newToken = "53000000-0000-4000-8000-000000000004";
    await store.claimFinalize(key, { token: oldToken, until: "2000-01-01T00:00:00.000Z" });
    await store.claimFinalize(key, { token: newToken, until: "2099-01-01T00:00:00.000Z" });
    await expect(store.rejectInvalid(key, oldToken)).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    const rows = await runtime.unsafe<{ state: string; lease_token: string }[]>("select state, lease_token from app_private.media_ingests where idempotency_key = $1", [key]);
    expect(rows[0]).toEqual({ state: "finalizing", lease_token: newToken });
  });

  it("PostgreSQL 時鐘拒絕 stale deadline 已過的 issued ingest claim", async () => {
    const service = serviceFor();
    await service.beginMediaUpload(owner, beginCommand());
    await runtime.unsafe("update app_private.media_ingests set stale_after = now() - interval '1 second' where idempotency_key = $1", [key]);

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey: key })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    const rows = await runtime.unsafe<{ state: string; asset_count: number }[]>(`
      select state, (select count(*)::int from app_private.media_assets where ingest_id = media_ingests.id) as asset_count
      from app_private.media_ingests where idempotency_key = $1
    `, [key]);
    expect(rows[0]).toEqual({ state: "issued", asset_count: 0 });
  });

  it("finalizing ingest 不可在未轉 finalized 時單獨提交 verified asset", async () => {
    const grant = grantFrom(await serviceFor().beginMediaUpload(owner, beginCommand()));
    const paths = await runtime.unsafe<{ original_object_path: string }[]>("select original_object_path from app_private.media_ingests where id = $1", [grant.ingestId]);
    const objectPath = paths[0].original_object_path;
    await runtime.unsafe(`
      update app_private.media_ingests
      set actual_mime_type = 'image/png', actual_byte_size = $2, image_width = 20, image_height = 30,
          state = 'finalizing', lease_token = '54000000-0000-4000-8000-000000000001', lease_until = now() + interval '5 minutes'
      where id = $1
    `, [grant.ingestId, png().byteLength]);

    await expect(runtime.unsafe(`
      insert into app_private.media_assets (
        id, ingest_id, game_id, purpose, original_object_path, original_file_name,
        actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type
      ) values ($1, $2, $3, 'gallery_image', $4, 'photo.png', 'image/png', $5, 20, 30, 'verified', 'user_cover', $4, 'image/png')
    `, [grant.assetId, grant.ingestId, gameId, objectPath, png().byteLength])).rejects.toThrow("media asset must match its finalized ingest ledger");
    const rows = await runtime.unsafe<{ asset_count: number }[]>("select count(*)::int as asset_count from app_private.media_assets where ingest_id = $1", [grant.ingestId]);
    expect(rows[0].asset_count).toBe(0);
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

  it("雙連線 row-lock 下未到期 lease 不可搶，逾時後新 attempt 接手且舊 token 晚到無法寫入", async () => {
    const service = serviceFor();
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const store = new PostgresMediaStore(database.db);
    const first = await store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000101", durationMs: 250 });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected thumbnail claim");
    const lease = await runtime.unsafe<{ db_clock_lease: boolean }[]>(`
      select lease_until > clock_timestamp() + interval '150 milliseconds'
        and lease_until <= clock_timestamp() + interval '250 milliseconds' as db_clock_lease
      from app_private.media_derivatives where asset_id = $1
    `, [grant.assetId]);
    expect(lease[0]?.db_clock_lease).toBe(true);

    const raceName = "thumbnail_claim_row_lock";
    const raceDatabase = createDatabase(namedRoleUrl("app_runtime", raceName));
    const locked = deferred();
    const release = deferred();
    const holder = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.media_derivatives set last_error_code = null where asset_id = $1", [grant.assetId]);
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const raced = new PostgresMediaStore(raceDatabase.db).claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000102" });
      await waitForDatabaseLock(raceName);
      release.resolve();
      await holder;
      await expect(raced).resolves.toEqual({ status: "busy" });
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await raceDatabase.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    const takeover = await store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000103" });
    expect(takeover).toMatchObject({ status: "claimed", attempt: { number: 2 } });
    await expect(store.markThumbnailUploaded({ derivativeId: first.derivativeId, attemptId: first.attempt.id, attemptNumber: first.attempt.number, leaseToken: "53000000-0000-4000-8000-000000000101" }))
      .rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    await expect(store.findReadableOriginal(grant.assetId)).resolves.toMatchObject({ fileName: "photo.png" });
  });

  it("等待 row lock 跨過 lease 後，舊 worker 不可寫入且新 claim 取得完整新租約", async () => {
    const service = serviceFor();
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const store = new PostgresMediaStore(database.db);
    const first = await store.claimThumbnail(grant.assetId, {
      token: "53000000-0000-4000-8000-000000000301",
      durationMs: 500,
    });
    if (first.status !== "claimed") throw new Error("expected short lease claim");

    const markName = "thumbnail_mark_clock_after_lock";
    const markDatabase = createDatabase(namedRoleUrl("app_runtime", markName));
    const locked = deferred();
    const release = deferred();
    const holder = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.media_derivatives set last_error_code = null where asset_id = $1", [grant.assetId]);
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const staleMark = new PostgresMediaStore(markDatabase.db).markThumbnailUploaded({
        derivativeId: first.derivativeId,
        attemptId: first.attempt.id,
        attemptNumber: first.attempt.number,
        leaseToken: "53000000-0000-4000-8000-000000000301",
      });
      await waitForDatabaseLock(markName);
      const beforeExpiry = await runtime.unsafe<{ remaining_ms: number }[]>(`
        select extract(epoch from lease_until - clock_timestamp()) * 1000 as remaining_ms
        from app_private.media_derivatives where asset_id = $1
      `, [grant.assetId]);
      expect(Number(beforeExpiry[0]?.remaining_ms)).toBeGreaterThan(250);
      await new Promise((resolve) => setTimeout(resolve, 600));
      release.resolve();
      await holder;
      await expect(staleMark).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await markDatabase.close();
    }

    const claimName = "thumbnail_claim_clock_after_lock";
    const claimDatabase = createDatabase(namedRoleUrl("app_runtime", claimName));
    const claimLocked = deferred();
    const releaseClaim = deferred();
    const claimHolder = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.media_derivatives set last_error_code = null where asset_id = $1", [grant.assetId]);
      claimLocked.resolve();
      await releaseClaim.promise;
    });
    try {
      await claimLocked.promise;
      const waitedClaim = new PostgresMediaStore(claimDatabase.db).claimThumbnail(grant.assetId, {
        token: "53000000-0000-4000-8000-000000000302",
        durationMs: 500,
      });
      await waitForDatabaseLock(claimName);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseClaim.resolve();
      await claimHolder;
      await expect(waitedClaim).resolves.toMatchObject({ status: "claimed", attempt: { number: 2 } });
      const remaining = await runtime.unsafe<{ remaining_ms: number }[]>(`
        select extract(epoch from lease_until - clock_timestamp()) * 1000 as remaining_ms
        from app_private.media_derivatives where asset_id = $1
      `, [grant.assetId]);
      expect(Number(remaining[0]?.remaining_ms)).toBeGreaterThan(250);
    } finally {
      releaseClaim.resolve();
      await claimHolder.catch(() => undefined);
      await claimDatabase.close();
    }
  });

  it("帳本 trigger 在取得 derivative lock 後重讀時鐘，adopt 後逾時不可轉 ready", async () => {
    const service = serviceFor();
    const firstGrant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const store = new PostgresMediaStore(database.db);
    const first = await store.claimThumbnail(firstGrant.assetId, {
      token: "53000000-0000-4000-8000-000000000401",
      durationMs: 500,
    });
    if (first.status !== "claimed") throw new Error("expected direct trigger claim");

    const transitionName = "thumbnail_attempt_trigger_clock_after_lock";
    const transition = postgres(namedRoleUrl("app_runtime", transitionName), options);
    const locked = deferred();
    const release = deferred();
    const holder = runtime.begin(async (tx) => {
      await tx.unsafe("update app_private.media_derivatives set last_error_code = null where id = $1", [first.derivativeId]);
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const upload = transition.unsafe(
        "update app_private.media_derivative_attempts set state = 'uploaded', uploaded_at = clock_timestamp() where id = $1",
        [first.attempt.id],
      ).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForDatabaseLock(transitionName);
      const beforeExpiry = await runtime.unsafe<{ remaining_ms: number }[]>(`
        select extract(epoch from lease_until - clock_timestamp()) * 1000 as remaining_ms
        from app_private.media_derivatives where id = $1
      `, [first.derivativeId]);
      expect(Number(beforeExpiry[0]?.remaining_ms)).toBeGreaterThan(250);
      await new Promise((resolve) => setTimeout(resolve, 600));
      release.resolve();
      await holder;
      const outcome = await upload;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("media derivative attempt transition requires active lease");
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
      await transition.end();
    }

    const secondKey = crypto.randomUUID();
    const secondGrant = grantFrom(await service.beginMediaUpload(owner, beginCommand({ idempotencyKey: secondKey })));
    await service.finalizeMediaUpload(owner, { idempotencyKey: secondKey });
    const second = await store.claimThumbnail(secondGrant.assetId, {
      token: "53000000-0000-4000-8000-000000000402",
      durationMs: 500,
    });
    if (second.status !== "claimed") throw new Error("expected ready transition claim");

    await store.markThumbnailUploaded({
      derivativeId: second.derivativeId,
      attemptId: second.attempt.id,
      attemptNumber: second.attempt.number,
      leaseToken: "53000000-0000-4000-8000-000000000402",
    });
    const completion = postgres(roleUrl("app_runtime"), options);
    try {
      await expect(completion.begin(async (tx) => {
        const adopted = await tx.unsafe<{ state: string }[]>(
          "update app_private.media_derivative_attempts set state = 'adopted' where id = $1 returning state",
          [second.attempt.id],
        );
        expect(adopted).toEqual([{ state: "adopted" }]);
        await tx.unsafe("select pg_sleep(0.6)");
        await tx.unsafe(`
          update app_private.media_derivatives
          set state = 'ready', active_attempt_id = null, adopted_attempt_id = $2,
              lease_token = null, lease_until = null,
              current_object_path = (select object_path from app_private.media_derivative_attempts where id = $2),
              object_key = (select object_path from app_private.media_derivative_attempts where id = $2),
              width = 1, height = 1, byte_size = 1, completed_at = clock_timestamp(),
              next_attempt_at = null, last_error_code = null
          where id = $1
        `, [second.derivativeId, second.attempt.id]);
      })).rejects.toThrow("verified thumbnail derivative completion transition is invalid");
    } finally {
      await completion.end();
    }
  });

  it("第三次暫時失敗封頂；手動 retry 開新週期但總 attempt 不歸零", async () => {
    const service = serviceFor();
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const store = new PostgresMediaStore(database.db);
    for (let number = 1; number <= 3; number += 1) {
      const claim = await store.claimThumbnail(grant.assetId, { token: `53000000-0000-4000-8000-00000000020${number}` });
      if (claim.status !== "claimed") throw new Error("expected automatic claim");
      await store.failThumbnail({ derivativeId: claim.derivativeId, attemptId: claim.attempt.id, attemptNumber: claim.attempt.number, leaseToken: `53000000-0000-4000-8000-00000000020${number}`, deterministic: false });
      if (number < 3) await runtime.unsafe("update app_private.media_derivatives set next_attempt_at = now() - interval '1 second' where asset_id = $1", [grant.assetId]);
    }
    const exhausted = await runtime.unsafe<{ state: string; attempt_count: number; cycle_attempt_count: number }[]>("select state, attempt_count, cycle_attempt_count from app_private.media_derivatives where asset_id = $1", [grant.assetId]);
    expect(exhausted[0]).toEqual({ state: "failed", attempt_count: 3, cycle_attempt_count: 3 });
    await expect(store.retryThumbnail(grant.assetId)).resolves.toMatchObject({ state: "pending" });
    const manual = await store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000204" });
    expect(manual).toMatchObject({ status: "claimed", attempt: { number: 4, cycleAttemptCount: 1 } });
  });

  it("第三次 worker crash 的過期 processing lease 收斂為 exhausted failed，手動 retry 可開新週期", async () => {
    const service = serviceFor();
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    const store = new PostgresMediaStore(database.db);

    for (let number = 1; number <= 2; number += 1) {
      const claim = await store.claimThumbnail(grant.assetId, { token: `53000000-0000-4000-8000-00000000031${number}` });
      if (claim.status !== "claimed") throw new Error("expected pre-exhaustion claim");
      await store.failThumbnail({
        derivativeId: claim.derivativeId,
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        leaseToken: `53000000-0000-4000-8000-00000000031${number}`,
        deterministic: false,
      });
      await runtime.unsafe("update app_private.media_derivatives set next_attempt_at = clock_timestamp() - interval '1 second' where asset_id = $1", [grant.assetId]);
    }
    const third = await store.claimThumbnail(grant.assetId, {
      token: "53000000-0000-4000-8000-000000000313",
      durationMs: 500,
    });
    if (third.status !== "claimed") throw new Error("expected third claim");
    const beforeExpiry = await runtime.unsafe<{ remaining_ms: number }[]>(`
      select extract(epoch from lease_until - clock_timestamp()) * 1000 as remaining_ms
      from app_private.media_derivatives where asset_id = $1
    `, [grant.assetId]);
    expect(Number(beforeExpiry[0]?.remaining_ms)).toBeGreaterThan(250);
    await new Promise((resolve) => setTimeout(resolve, 600));

    await expect(store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000314" }))
      .resolves.toEqual({ status: "not_ready" });
    const exhausted = await runtime.unsafe<{ state: string; attempt_count: number; cycle_attempt_count: number; last_error_code: string | null; attempt_rows: number }[]>(`
      select derivative.state, derivative.attempt_count, derivative.cycle_attempt_count, derivative.last_error_code,
        (select count(*)::int from app_private.media_derivative_attempts attempt where attempt.derivative_id = derivative.id) as attempt_rows
      from app_private.media_derivatives derivative where derivative.asset_id = $1
    `, [grant.assetId]);
    expect(exhausted[0]).toEqual({
      state: "failed", attempt_count: 3, cycle_attempt_count: 3,
      last_error_code: "media_thumbnail_retry_exhausted", attempt_rows: 3,
    });
    await expect(store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000315" }))
      .resolves.toEqual({ status: "not_ready" });
    const afterRepeatClaim = await runtime.unsafe<{ attempt_rows: number }[]>(`
      select count(*)::int as attempt_rows from app_private.media_derivative_attempts where derivative_id = $1
    `, [third.derivativeId]);
    expect(afterRepeatClaim[0]?.attempt_rows).toBe(3);

    await expect(store.retryThumbnail(grant.assetId)).resolves.toMatchObject({ state: "pending" });
    await expect(store.claimThumbnail(grant.assetId, { token: "53000000-0000-4000-8000-000000000316" }))
      .resolves.toMatchObject({ status: "claimed", attempt: { number: 4, cycleAttemptCount: 1 } });
  });

  it("upload 成功後 pointer transaction 失敗不回滾 original，uploaded attempt 保留精確帳", async () => {
    const source = new Uint8Array(await sharp({ create: { width: 20, height: 30, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer());
    const uploads: string[] = [];
    const objectStore: MediaObjectStore = {
      async createUploadGrant(path) { void path; return { uploadUrl: "https://storage.example.test/upload", token: "opaque", expiresAt: "2026-09-06T02:00:00.000Z" }; },
      async createOriginalReadGrant() { return { url: "https://storage.example.test/signed?token=opaque", expiresAt: "2026-09-06T00:01:00.000Z" }; },
      async inspect(path) { return { path, byteSize: source.byteLength, mimeType: "image/png" }; },
      async *read() { yield source; },
      async uploadDerivative(path) { uploads.push(path); },
    };
    const actual = new PostgresMediaStore(database.db);
    const failing: MediaStore = {
      begin: actual.begin.bind(actual), renewGrant: actual.renewGrant.bind(actual), claimFinalize: actual.claimFinalize.bind(actual),
      releaseIncomplete: actual.releaseIncomplete.bind(actual), rejectInvalid: actual.rejectInvalid.bind(actual), completeFinalize: actual.completeFinalize.bind(actual),
      findReadableOriginal: actual.findReadableOriginal.bind(actual), claimThumbnail: actual.claimThumbnail.bind(actual),
      markThumbnailUploaded: actual.markThumbnailUploaded.bind(actual), failThumbnail: actual.failThumbnail.bind(actual), retryThumbnail: actual.retryThumbnail.bind(actual),
      listGameMedia: actual.listGameMedia.bind(actual), updateMediaMetadata: actual.updateMediaMetadata.bind(actual),
      selectManualCover: actual.selectManualCover.bind(actual), useSourceCover: actual.useSourceCover.bind(actual),
      removeMedia: actual.removeMedia.bind(actual), restoreMedia: actual.restoreMedia.bind(actual),
      async adoptThumbnail() { throw new Error("injected pointer transaction failure"); },
    };
    const delays: number[] = [];
    let thumbnailAssetId: string | null = null;
    const service = createMediaService({
      store: failing,
      objects: objectStore,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        await runtime.unsafe("update app_private.media_derivatives set next_attempt_at = now() - interval '1 second' where asset_id = $1", [thumbnailAssetId]);
      },
    });
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand({ declaredByteSize: source.byteLength })));
    thumbnailAssetId = grant.assetId;
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    await expect(service.processThumbnail(grant.assetId)).resolves.toBeUndefined();
    expect({ uploads: uploads.length, delays }).toEqual({ uploads: 3, delays: [1_000, 5_000] });
    await expect(actual.findReadableOriginal(grant.assetId)).resolves.toMatchObject({ fileName: "photo.png" });
    const rows = await runtime.unsafe<{ state: string; current_object_path: string | null; uploaded_attempts: number }[]>(`
      select derivative.state, derivative.current_object_path,
        (select count(*)::int from app_private.media_derivative_attempts attempt where attempt.derivative_id = derivative.id and attempt.state = 'uploaded') as uploaded_attempts
      from app_private.media_derivatives derivative
      where derivative.asset_id = $1
    `, [grant.assetId]);
    expect(rows[0]).toEqual({ state: "failed", current_object_path: null, uploaded_attempts: 3 });
  });

  it("同一 invocation 以有界 backoff 重試 transient source stream failure，第二 attempt 採用為 ready", async () => {
    const source = new Uint8Array(await sharp({ create: { width: 1_280, height: 320, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer());
    let uploads = 0;
    let reads = 0;
    const objectStore: MediaObjectStore = {
      async createUploadGrant(path) { void path; return { uploadUrl: "https://storage.example.test/upload", token: "opaque", expiresAt: "2026-09-06T02:00:00.000Z" }; },
      async createOriginalReadGrant() { return { url: "https://storage.example.test/signed?token=opaque", expiresAt: "2026-09-06T00:01:00.000Z" }; },
      async inspect(path) { return { path, byteSize: source.byteLength, mimeType: "image/png" }; },
      async *read() { reads += 1; if (reads === 2) throw new MediaStorageUnavailableError(); yield source; },
      async uploadDerivative() { uploads += 1; },
    };
    const delays: number[] = [];
    let thumbnailAssetId: string | null = null;
    const service = createMediaService({
      store: new PostgresMediaStore(database.db),
      objects: objectStore,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        await runtime.unsafe("update app_private.media_derivatives set next_attempt_at = now() - interval '1 second' where asset_id = $1", [thumbnailAssetId]);
      },
    });
    const grant = grantFrom(await service.beginMediaUpload(owner, beginCommand({ declaredByteSize: source.byteLength })));
    thumbnailAssetId = grant.assetId;
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    await expect(service.processThumbnail(grant.assetId)).resolves.toBeUndefined();
    expect({ reads, uploads, delays }).toEqual({ reads: 3, uploads: 1, delays: [1_000] });
    const rows = await runtime.unsafe<{ state: string; attempt_count: number; cycle_attempt_count: number; width: number; height: number; adopted_attempts: number }[]>(`
      select derivative.state, derivative.attempt_count, derivative.cycle_attempt_count, derivative.width, derivative.height,
        (select count(*)::int from app_private.media_derivative_attempts attempt where attempt.derivative_id = derivative.id and attempt.state = 'adopted') as adopted_attempts
      from app_private.media_derivatives derivative where derivative.asset_id = $1
    `, [grant.assetId]);
    expect(rows[0]).toEqual({ state: "ready", attempt_count: 2, cycle_attempt_count: 2, width: 640, height: 160, adopted_attempts: 1 });
  });

  it("相簿查詢、說明更新與人工／來源封面切換共用同一權威 asset", async () => {
    const service = serviceFor();
    const image = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    await expect(service.updateMediaMetadata(owner, { assetId: image.assetId, caption: "  桌遊夜  " }))
      .resolves.toMatchObject({ caption: "桌遊夜" });
    await expect(service.selectManualCover(owner, { gameId, assetId: image.assetId }))
      .resolves.toEqual({ manualCoverAssetId: image.assetId });

    const attachmentKey = crypto.randomUUID();
    const attachmentBytes = new TextEncoder().encode("rules");
    const attachmentService = serviceFor(objects(attachmentBytes, "application/pdf"));
    const attachment = grantFrom(await attachmentService.beginMediaUpload(owner, beginCommand({ idempotencyKey: attachmentKey, purpose: "attachment", originalFileName: "rules.pdf", declaredMimeType: "application/pdf", declaredByteSize: attachmentBytes.byteLength })));
    await attachmentService.finalizeMediaUpload(owner, { idempotencyKey: attachmentKey });
    await expect(attachmentService.updateMediaMetadata(owner, { assetId: attachment.assetId, displayName: "規則書", description: "  中文版  " }))
      .resolves.toMatchObject({ displayName: "規則書", description: "中文版" });

    const gallery = await service.listGameMedia(owner, { gameId });
    expect(gallery.manualCoverAssetId).toBe(image.assetId);
    expect(gallery.items.find((item) => item.asset.id === image.assetId)?.asset.caption).toBe("桌遊夜");
    expect(gallery.items.find((item) => item.asset.id === attachment.assetId)?.asset).toMatchObject({ displayName: "規則書", description: "中文版" });
    await expect(service.useSourceCover(owner, { gameId })).resolves.toEqual({ manualCoverAssetId: null });
    await expect(service.listGameMedia(owner, { gameId })).resolves.toMatchObject({ manualCoverAssetId: null });
  });

  it("移除自訂封面會在同一交易清除指標，還原資產不會偷偷重新指定封面", async () => {
    const service = serviceFor();
    const image = grantFrom(await service.beginMediaUpload(owner, beginCommand()));
    await service.finalizeMediaUpload(owner, { idempotencyKey: key });
    await service.selectManualCover(owner, { gameId, assetId: image.assetId });

    await expect(service.removeMedia(owner, { assetId: image.assetId })).resolves.toMatchObject({
      asset: { id: image.assetId, removedAt: expect.any(String) },
      manualCoverAssetId: null,
    });
    await expect(service.listGameMedia(owner, { gameId })).resolves.toMatchObject({
      manualCoverAssetId: null,
      items: [],
    });

    await expect(service.restoreMedia(owner, { assetId: image.assetId })).resolves.toMatchObject({
      id: image.assetId,
      removedAt: null,
    });
    const restored = await service.listGameMedia(owner, { gameId });
    expect(restored.manualCoverAssetId).toBeNull();
    expect(restored.items.map((item) => item.asset.id)).toContain(image.assetId);
  });
});

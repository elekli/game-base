import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDatabase } from "@/adapters/database";
import { PostgresMediaStore } from "@/adapters/postgres-media-store";
import {
  MediaAssetUnavailableError,
  MediaStoredObjectInvalidError,
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
  type BeginMediaUploadResult,
  type FinalizeMediaUploadResult,
  type MediaUploadResult,
} from "@/modules/media";
import { createMediaService } from "@/modules/media/internal/create-media-service";
import type { MediaObjectStore } from "@/modules/media/internal/types";

function grantFrom(result: BeginMediaUploadResult) {
  if (result.status !== "upload_grant") throw new Error("expected upload grant");
  return result;
}

function finalizedFrom(result: FinalizeMediaUploadResult): MediaUploadResult {
  if ("status" in result) throw new Error("expected finalized upload");
  return result;
}

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
  };
}

let control: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;
let database: ReturnType<typeof createDatabase>;

async function clean(): Promise<void> {
  await control.unsafe("set session_replication_role = replica");
  try {
    await control.unsafe("update app_private.games set manual_cover_asset_id = null where id = $1", [gameId]);
    await control.unsafe("delete from app_private.media_derivative_attempts where derivative_id in (select id from app_private.media_derivatives where asset_id in (select id from app_private.media_assets where game_id = $1))", [gameId]);
    await control.unsafe("delete from app_private.media_derivatives where asset_id in (select id from app_private.media_assets where game_id = $1)", [gameId]);
    await control.unsafe("delete from app_private.media_assets where game_id = $1", [gameId]);
    await control.unsafe("delete from app_private.media_ingest_operations where game_id = $1", [gameId]);
    await control.unsafe("delete from app_private.media_ingests where game_id = $1", [gameId]);
    await control.unsafe("delete from app_private.games where id = $1", [gameId]);
  } finally {
    await control.unsafe("set session_replication_role = origin");
  }
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
});

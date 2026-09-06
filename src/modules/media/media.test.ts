import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_MAX_BYTES,
  MediaFileEmptyError,
  MediaFileTooLargeError,
  MediaStoredObjectInvalidError,
  MediaFinalizeUnavailableError,
  MediaUploadIdempotencyConflictError,
  createInMemoryMediaStore,
  createMediaService,
  type BeginMediaUploadResult,
  type MediaObjectStore,
} from "./index";

function grantFrom(result: BeginMediaUploadResult) {
  if (result.status !== "upload_grant") throw new Error("expected upload grant");
  return result;
}

const owner = { sub: "owner-subject" };
const gameId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

function png(width = 2, height = 3): Uint8Array {
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
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function jpeg(width = 2, height = 3): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x01, 0xff, 0xd9,
  ]);
}

function gif(width = 2, height = 3): Uint8Array {
  return Uint8Array.from([
    ...new TextEncoder().encode("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0,
    0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0,
    2, 2, 0x4c, 0x01, 0, 0x3b,
  ]);
}

function webp(width = 2, height = 3): Uint8Array {
  const result = new Uint8Array(26);
  result.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(result.buffer).setUint32(4, 18, true);
  result.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(result.buffer).setUint32(16, 5, true);
  result[20] = 0x2f;
  new DataView(result.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return result;
}

function objectStore(object: Readonly<{ bytes: Uint8Array; mimeType: string; byteSize?: number }>): MediaObjectStore {
  return {
    async createUploadGrant(path) { return { token: `grant:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }; },
    async inspect(path) { return { path, byteSize: object.byteSize ?? object.bytes.byteLength, mimeType: object.mimeType }; },
    async *read(path) { void path; yield object.bytes; },
  };
}

function command(overrides: Partial<Readonly<{ purpose: "gallery_image" | "custom_cover" | "attachment"; originalFileName: string; declaredMimeType: string; declaredByteSize: number }>> = {}) {
  return {
    idempotencyKey,
    gameId,
    purpose: "gallery_image" as const,
    originalFileName: "桌遊照片.png",
    declaredMimeType: "image/png",
    declaredByteSize: png().byteLength,
    ...overrides,
  };
}

describe("媒體公開介面", () => {
  it("begin 對同一原檔冪等，且拒絕相同鍵配上不同不可變參數", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: png(), mimeType: "image/png" }),
    });

    const first = grantFrom(await service.beginMediaUpload(owner, command()));
    const replay = grantFrom(await service.beginMediaUpload(owner, command()));

    expect(replay).toEqual(first);
    expect(first.objectPath).toMatch(new RegExp(`^originals/${first.assetId}/[0-9a-f-]{36}$`));
    await expect(service.beginMediaUpload(owner, command({ originalFileName: "另一張.png" })))
      .rejects.toBeInstanceOf(MediaUploadIdempotencyConflictError);
  });

  it("grant ledger CAS 必須在 Storage 簽發能力之前完成", async () => {
    const base = createInMemoryMediaStore({ activeGameIds: [gameId] });
    const createUploadGrant = vi.fn(async (path: string) => ({ token: path, expiresAt: "2026-09-06T02:00:00.000Z" }));
    const service = createMediaService({
      store: { ...base, renewGrant: async () => { throw new Error("cleanup won"); } },
      objects: { ...objectStore({ bytes: png(), mimeType: "image/png" }), createUploadGrant },
    });

    await expect(service.beginMediaUpload(owner, command())).rejects.toThrow("cleanup won");
    expect(createUploadGrant).not.toHaveBeenCalled();
  });

  it("begin 對空檔與超過 50 MiB 使用相同的具名邊界錯誤", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: png(), mimeType: "image/png" }),
    });

    await expect(service.beginMediaUpload(owner, command({ declaredByteSize: 0 })))
      .rejects.toBeInstanceOf(MediaFileEmptyError);
    await expect(service.beginMediaUpload(owner, command({ declaredByteSize: MEDIA_MAX_BYTES + 1 })))
      .rejects.toBeInstanceOf(MediaFileTooLargeError);
  });

  it("finalize 從點陣檔頭確認 MIME 與尺寸，重播只回同一 asset", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: png(), mimeType: "image/png" }),
    });
    const grant = grantFrom(await service.beginMediaUpload(owner, command()));

    const first = await service.finalizeMediaUpload(owner, { idempotencyKey });
    const replay = await service.finalizeMediaUpload(owner, { idempotencyKey });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      asset: { id: grant.assetId, purpose: "gallery_image", actualMimeType: "image/png", width: 2, height: 3 },
      thumbnail: { spec: "thumb_webp_v1", state: "pending" },
    });
  });

  it("begin 重播 finalized／finalizing ingest 不再簽發可覆寫原檔的 grant", async () => {
    const store = createInMemoryMediaStore({ activeGameIds: [gameId] });
    const createUploadGrant = vi.fn(async (path: string) => ({ token: `grant:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }));
    const service = createMediaService({ store, objects: { ...objectStore({ bytes: png(), mimeType: "image/png" }), createUploadGrant } });
    await service.beginMediaUpload(owner, command());
    const finalized = await service.finalizeMediaUpload(owner, { idempotencyKey });

    await expect(service.beginMediaUpload(owner, command())).resolves.toEqual({ status: "already_finalized", result: finalized });
    await expect(service.beginMediaUpload(owner, command({ originalFileName: "finalized-different.png" })))
      .rejects.toBeInstanceOf(MediaUploadIdempotencyConflictError);
    expect(createUploadGrant).toHaveBeenCalledTimes(1);

    const secondKey = "22222222-2222-4222-8222-222222222223";
    await service.beginMediaUpload(owner, { ...command(), idempotencyKey: secondKey });
    await store.claimFinalize(secondKey, { token: "33333333-3333-4333-8333-333333333333", until: new Date(Date.now() + 60_000).toISOString() });
    await expect(service.beginMediaUpload(owner, { ...command(), idempotencyKey: secondKey })).resolves.toEqual({ status: "finalizing" });
    expect(createUploadGrant).toHaveBeenCalledTimes(2);
  });

  it("過期 lease 即使 token 未被取代也不得完成 finalize", async () => {
    const start = new Date("2026-09-06T00:00:00.000Z");
    const store = createInMemoryMediaStore({ activeGameIds: [gameId], now: () => new Date(start.getTime() + 10 * 60_000) });
    const service = createMediaService({ store, objects: objectStore({ bytes: png(), mimeType: "image/png" }), now: () => start });
    await service.beginMediaUpload(owner, command());

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
  });

  it("issued ingest 超過 stale deadline 後不得再 claim finalize", async () => {
    const start = new Date("2026-09-06T00:00:00.000Z");
    const store = createInMemoryMediaStore({ activeGameIds: [gameId], now: () => new Date(start.getTime() + 27 * 60 * 60_000) });
    const service = createMediaService({ store, objects: objectStore({ bytes: png(), mimeType: "image/png" }), now: () => start });
    await service.beginMediaUpload(owner, command());

    await expect(store.claimFinalize(idempotencyKey, {
      token: "33333333-3333-4333-8333-333333333334",
      until: new Date(start.getTime() + 28 * 60 * 60_000).toISOString(),
    })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
  });

  it.each(["inspect", "read", "commit"] as const)("未知 %s failure 轉成具名 unavailable 且保留重試狀態", async (failure) => {
    const store = createInMemoryMediaStore({ activeGameIds: [gameId] });
    const baseObjects = objectStore({ bytes: png(), mimeType: "image/png" });
    const objectsWithFailure: MediaObjectStore = failure === "inspect"
      ? { ...baseObjects, inspect: async () => { throw new Error("raw inspect failure"); } }
      : failure === "read"
        ? { ...baseObjects, read: () => (async function* () { throw new Error("raw read failure"); })() }
        : baseObjects;
    const storeWithFailure = failure === "commit"
      ? { ...store, completeFinalize: async () => { throw new Error("raw commit failure"); } }
      : store;
    const service = createMediaService({ store: storeWithFailure, objects: objectsWithFailure });
    await service.beginMediaUpload(owner, command());

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    await expect(service.beginMediaUpload(owner, command())).resolves.toEqual({ status: "finalizing" });
  });

  it.each([
    ["PNG", "image/png", png()],
    ["JPEG", "image/jpeg", jpeg()],
    ["GIF", "image/gif", gif()],
    ["WebP", "image/webp", webp()],
  ])("finalize 只接受結構完整的 %s", async (_name, mimeType, bytes) => {
    const complete = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes, mimeType }),
    });
    await complete.beginMediaUpload(owner, command({ declaredMimeType: mimeType, declaredByteSize: bytes.byteLength }));
    await expect(complete.finalizeMediaUpload(owner, { idempotencyKey })).resolves.toMatchObject({ asset: { actualMimeType: mimeType, width: 2, height: 3 } });

    const truncatedBytes = bytes.subarray(0, bytes.byteLength - 1);
    const truncated = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: truncatedBytes, mimeType }),
    });
    await truncated.beginMediaUpload(owner, command({ declaredMimeType: mimeType, declaredByteSize: truncatedBytes.byteLength }));
    await expect(truncated.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("finalize 拒絕宣稱／Storage metadata／點陣檔頭 MIME 不一致與 SVG", async () => {
    const makeService = (bytes: Uint8Array, mimeType: string) => createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes, mimeType }),
    });

    const wrongMetadata = makeService(png(), "image/jpeg");
    await wrongMetadata.beginMediaUpload(owner, command());
    await expect(wrongMetadata.finalizeMediaUpload(owner, { idempotencyKey }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);

    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const svg = makeService(svgBytes, "image/svg+xml");
    await svg.beginMediaUpload(owner, command({ declaredMimeType: "image/svg+xml", declaredByteSize: svgBytes.byteLength }));
    await expect(svg.finalizeMediaUpload(owner, { idempotencyKey }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);

    const forgedPng = png().subarray(0, 24);
    const truncated = makeService(forgedPng, "image/png");
    await truncated.beginMediaUpload(owner, command({ declaredByteSize: forgedPng.byteLength }));
    await expect(truncated.finalizeMediaUpload(owner, { idempotencyKey }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);

    const sizeMismatch = makeService(png(), "image/png");
    await sizeMismatch.beginMediaUpload(owner, command({ declaredByteSize: 23 }));
    await expect(sizeMismatch.finalizeMediaUpload(owner, { idempotencyKey }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);

    const excessivePixels = makeService(png(10_001, 10_000), "image/png");
    await excessivePixels.beginMediaUpload(owner, command());
    await expect(excessivePixels.finalizeMediaUpload(owner, { idempotencyKey }))
      .rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("附件不採信宣稱 MIME，僅由內容辨識 PDF，且不建立 derivative", async () => {
    const bytes = new TextEncoder().encode("plain attachment");
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes, mimeType: "image/png" }),
    });
    await service.beginMediaUpload(owner, command({
      purpose: "attachment",
      originalFileName: "規則書.exe",
      declaredMimeType: "application/pdf",
      declaredByteSize: bytes.byteLength,
    }));

    const result = await service.finalizeMediaUpload(owner, { idempotencyKey });

    expect(result.asset.actualMimeType).toBe("application/octet-stream");
    expect(result.thumbnail).toBeNull();
  });
});

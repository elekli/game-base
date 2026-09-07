import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_MAX_BYTES,
  MediaBeginUnavailableError,
  MediaFileEmptyError,
  MediaFileTooLargeError,
  MediaStoredObjectInvalidError,
  MediaFinalizeUnavailableError,
  MediaUploadIdempotencyConflictError,
  MediaStorageUnavailableError,
  type BeginMediaUploadResult,
} from "./index";
import { createMediaService } from "./internal/create-media-service";
import { createInMemoryMediaStore } from "./internal/in-memory-store";
import type { MediaObjectStore } from "./internal/types";

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

function animatedWebp(input: Readonly<{
  frameWidth?: number;
  frameHeight?: number;
  bitstreamWidth?: number;
  bitstreamHeight?: number;
  bitstreamCount?: number;
  codec?: "VP8L" | "VP8 ";
  includeAnim?: boolean;
}> = {}): Uint8Array {
  const frameWidth = input.frameWidth ?? 2;
  const frameHeight = input.frameHeight ?? 3;
  const bitstreamWidth = input.bitstreamWidth ?? frameWidth;
  const bitstreamHeight = input.bitstreamHeight ?? frameHeight;
  const codec = input.codec ?? "VP8L";
  const losslessHeader = new Uint8Array(5);
  losslessHeader[0] = 0x2f;
  new DataView(losslessHeader.buffer).setUint32(1, (bitstreamWidth - 1) | ((bitstreamHeight - 1) << 14), true);
  const bitstream = codec === "VP8L"
    ? losslessHeader
    : Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a, bitstreamWidth & 0xff, bitstreamWidth >> 8, bitstreamHeight & 0xff, bitstreamHeight >> 8]);
  const nested = Uint8Array.from([
    ...new TextEncoder().encode(codec), bitstream.byteLength, 0, 0, 0, ...bitstream,
    ...(bitstream.byteLength % 2 === 1 ? [0] : []),
  ]);
  const framePayload = new Uint8Array(16 + nested.byteLength * (input.bitstreamCount ?? 1));
  framePayload[6] = frameWidth - 1;
  framePayload[9] = frameHeight - 1;
  for (let index = 0; index < (input.bitstreamCount ?? 1); index += 1) framePayload.set(nested, 16 + nested.byteLength * index);
  const includeAnim = input.includeAnim ?? true;
  const animLength = includeAnim ? 14 : 0;
  const result = new Uint8Array(12 + 18 + animLength + 8 + framePayload.byteLength);
  result.set(new TextEncoder().encode("RIFF"));
  new DataView(result.buffer).setUint32(4, result.byteLength - 8, true);
  result.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(result.buffer).setUint32(16, 10, true);
  result[20] = 0x02;
  result[24] = 1;
  result[27] = 2;
  if (includeAnim) {
    result.set(new TextEncoder().encode("ANIM"), 30);
    new DataView(result.buffer).setUint32(34, 6, true);
  }
  const frameOffset = 30 + animLength;
  result.set(new TextEncoder().encode("ANMF"), frameOffset);
  new DataView(result.buffer).setUint32(frameOffset + 4, framePayload.byteLength, true);
  result.set(framePayload, frameOffset + 8);
  return result;
}

function objectStore(object: Readonly<{ bytes: Uint8Array; mimeType: string; byteSize?: number }>): MediaObjectStore {
  return {
    async createUploadGrant(path) { return { uploadUrl: "https://storage.example.test/upload/resumable/sign", token: `grant:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }; },
    async createOriginalReadGrant(path, fileName) { return { url: `https://storage.example.test/signed/${encodeURIComponent(path)}?download=${encodeURIComponent(fileName)}`, expiresAt: "2026-09-06T00:01:00.000Z" }; },
    async inspect(path) { return { path, byteSize: object.byteSize ?? object.bytes.byteLength, mimeType: object.mimeType }; },
    async *read(path) { void path; yield object.bytes; },
    async uploadDerivative() {},
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
  it("upload capability 固定 TUS transport、單一 ingest/path/size/MIME 與安全重試選項", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: png(), mimeType: "image/png" }),
    });

    const grant = grantFrom(await service.beginMediaUpload(owner, command()));

    expect(grant.upload).toMatchObject({
      protocol: "tus",
      endpoint: "https://storage.example.test/upload/resumable/sign",
      headers: { "x-signature": expect.stringContaining("grant:") },
      metadata: {
        bucketName: "game-media",
        objectName: expect.stringMatching(/^originals\/[0-9a-f-]+\/[0-9a-f-]+$/),
        contentType: "image/png",
        cacheControl: "0",
      },
      declaredByteSize: png().byteLength,
      maxByteSize: MEDIA_MAX_BYTES,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      uploadDataDuringCreation: true,
      resumeFromPreviousUpload: true,
      removeFingerprintOnSuccess: true,
      upsert: false,
      fingerprint: `puizeru:${grant.ingestId}:${grant.upload.metadata.objectName}`,
    });
    expect(grant.upload).not.toHaveProperty("authorization");
    expect(grant.upload.headers).not.toHaveProperty("authorization");
  });

  it("begin 回應遺失後重發新 token，但保留同一 TUS resume fingerprint 與 object path", async () => {
    let attempt = 0;
    const objects = objectStore({ bytes: png(), mimeType: "image/png" });
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: { ...objects, async createUploadGrant() { attempt += 1; return { uploadUrl: "https://storage.example.test/upload/resumable/sign", token: `token-${attempt}`, expiresAt: "2026-09-06T02:00:00.000Z" }; } },
    });

    const first = grantFrom(await service.beginMediaUpload(owner, command()));
    const retry = grantFrom(await service.beginMediaUpload(owner, command()));

    expect(retry.ingestId).toBe(first.ingestId);
    expect(retry.assetId).toBe(first.assetId);
    expect(retry.upload.fingerprint).toBe(first.upload.fingerprint);
    expect(retry.upload.metadata.objectName).toBe(first.upload.metadata.objectName);
    expect(retry.upload.headers["x-signature"]).not.toBe(first.upload.headers["x-signature"]);
  });

  it("finalized asset 每次重新授權才取得 60 秒 attachment signed read", async () => {
    const signed = vi.fn(async (_path: string, fileName: string) => ({
      url: `https://storage.example.test/signed/original?download=${encodeURIComponent(fileName)}&token=opaque`,
      expiresAt: "2026-09-06T00:01:00.000Z",
    }));
    const store = createInMemoryMediaStore({ activeGameIds: [gameId], now: () => new Date("2026-09-06T00:00:00.000Z") });
    const service = createMediaService({
      store,
      objects: { ...objectStore({ bytes: png(), mimeType: "image/png" }), createOriginalReadGrant: signed },
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    await service.beginMediaUpload(owner, command());
    const finalized = await service.finalizeMediaUpload(owner, { idempotencyKey });
    if ("status" in finalized) throw new Error("expected finalized upload");

    const first = await service.issueOriginalRead(owner, { assetId: finalized.asset.id });
    const second = await service.issueOriginalRead(owner, { assetId: finalized.asset.id });

    expect(first).toEqual({
      status: "original_read",
      url: expect.stringContaining("download="),
      expiresAt: "2026-09-06T00:01:00.000Z",
      disposition: "attachment",
    });
    expect(second.url).toContain("token=opaque");
    expect(signed).toHaveBeenCalledTimes(2);
    expect(signed).toHaveBeenCalledWith(expect.stringMatching(/^originals\//), "桌遊照片.png", "attachment", 60);
  });
  it("begin 對同一原檔冪等，且拒絕相同鍵配上不同不可變參數", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: objectStore({ bytes: png(), mimeType: "image/png" }),
    });

    const first = grantFrom(await service.beginMediaUpload(owner, command()));
    const replay = grantFrom(await service.beginMediaUpload(owner, command()));

    expect(replay).toEqual(first);
    expect(first).not.toHaveProperty("objectPath");
    await expect(service.beginMediaUpload(owner, command({ originalFileName: "另一張.png" })))
      .rejects.toBeInstanceOf(MediaUploadIdempotencyConflictError);
  });

  it("grant ledger CAS 必須在 Storage 簽發能力之前完成", async () => {
    const base = createInMemoryMediaStore({ activeGameIds: [gameId] });
    const createUploadGrant = vi.fn(async (path: string) => ({ uploadUrl: `https://storage.example.test/upload/${encodeURIComponent(path)}`, token: path, expiresAt: "2026-09-06T02:00:00.000Z" }));
    const service = createMediaService({
      store: { ...base, renewGrant: async () => { throw new Error("cleanup won"); } },
      objects: { ...objectStore({ bytes: png(), mimeType: "image/png" }), createUploadGrant },
    });

    await expect(service.beginMediaUpload(owner, command())).rejects.toBeInstanceOf(MediaBeginUnavailableError);
    expect(createUploadGrant).not.toHaveBeenCalled();
  });

  it("Storage grant 原始失敗轉成 begin unavailable，既有 ingest 可重試", async () => {
    const store = createInMemoryMediaStore({ activeGameIds: [gameId] });
    let attempts = 0;
    const objects = { ...objectStore({ bytes: png(), mimeType: "image/png" }), async createUploadGrant(path: string) {
      attempts += 1;
      if (attempts === 1) throw new Error("raw grant failure");
      return { uploadUrl: `https://storage.example.test/upload/${encodeURIComponent(path)}`, token: path, expiresAt: "2026-09-06T02:00:00.000Z" };
    } };
    const service = createMediaService({ store, objects });
    await expect(service.beginMediaUpload(owner, command())).rejects.toBeInstanceOf(MediaBeginUnavailableError);
    await expect(service.beginMediaUpload(owner, command())).resolves.toMatchObject({ status: "upload_grant" });
  });

  it("正式 Storage adapter 的具名 grant failure 不穿透深模組 begin 邊界", async () => {
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: { ...objectStore({ bytes: png(), mimeType: "image/png" }), async createUploadGrant() { throw new MediaStorageUnavailableError(); } },
    });
    await expect(service.beginMediaUpload(owner, command())).rejects.toBeInstanceOf(MediaBeginUnavailableError);
  });

  it("正式 Storage adapter 的具名 inspect failure 不穿透深模組 finalize 邊界", async () => {
    const objects = objectStore({ bytes: png(), mimeType: "image/png" });
    const service = createMediaService({
      store: createInMemoryMediaStore({ activeGameIds: [gameId] }),
      objects: { ...objects, async inspect() { throw new MediaStorageUnavailableError(); } },
    });
    await service.beginMediaUpload(owner, command());
    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
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
    const createUploadGrant = vi.fn(async (path: string) => ({ uploadUrl: `https://storage.example.test/upload/${encodeURIComponent(path)}`, token: `grant:${path}`, expiresAt: "2026-09-06T02:00:00.000Z" }));
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

  it("過期 lease 不得 release incomplete", async () => {
    let current = new Date("2026-09-06T00:00:00.000Z");
    const store = createInMemoryMediaStore({ activeGameIds: [gameId], now: () => current });
    const service = createMediaService({ store, objects: objectStore({ bytes: png(), mimeType: "image/png" }), now: () => current });
    await service.beginMediaUpload(owner, command());
    const token = "33333333-3333-4333-8333-333333333335";
    await store.claimFinalize(idempotencyKey, { token, until: new Date(current.getTime() + 60_000).toISOString() });
    current = new Date(current.getTime() + 120_000);
    await expect(store.releaseIncomplete(idempotencyKey, token)).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    await expect(service.beginMediaUpload(owner, command())).resolves.toEqual({ status: "finalizing" });
  });

  it("被新 worker 取代的 token 不得 reject invalid", async () => {
    let current = new Date("2026-09-06T00:00:00.000Z");
    const store = createInMemoryMediaStore({ activeGameIds: [gameId], now: () => current });
    const service = createMediaService({ store, objects: objectStore({ bytes: png(), mimeType: "image/png" }), now: () => current });
    await service.beginMediaUpload(owner, command());
    const oldToken = "33333333-3333-4333-8333-333333333336";
    await store.claimFinalize(idempotencyKey, { token: oldToken, until: new Date(current.getTime() + 60_000).toISOString() });
    current = new Date(current.getTime() + 120_000);
    await store.claimFinalize(idempotencyKey, { token: "33333333-3333-4333-8333-333333333337", until: new Date(current.getTime() + 60_000).toISOString() });
    await expect(store.rejectInvalid(idempotencyKey, oldToken)).rejects.toBeInstanceOf(MediaFinalizeUnavailableError);
    await expect(service.beginMediaUpload(owner, command())).resolves.toEqual({ status: "finalizing" });
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

  it("拒絕只有 SOF 後直接 EOI、沒有 SOS 與 scan data 的 JPEG", async () => {
    const bytes = Uint8Array.from([...jpeg().subarray(0, 15), 0xff, 0xd9]);
    const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/jpeg" }) });
    await service.beginMediaUpload(owner, command({ declaredMimeType: "image/jpeg", declaredByteSize: bytes.byteLength, originalFileName: "bad.jpg" }));
    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("拒絕 frame 超出 logical screen 且超過像素上限的 28-byte GIF", async () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0,
      2, 1, 0, 0, 0x3b,
    ]);
    const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/gif" }) });
    await service.beginMediaUpload(owner, command({ declaredMimeType: "image/gif", declaredByteSize: bytes.byteLength, originalFileName: "oversized-frame.gif" }));

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("以分塊掃描大型 JPEG entropy", async () => {
    const base = jpeg();
    const bytes = new Uint8Array(base.byteLength + 2_000_000);
    bytes.set(base.subarray(0, base.byteLength - 2));
    bytes.fill(1, base.byteLength - 2, bytes.byteLength - 2);
    bytes.set([0xff, 0xd9], bytes.byteLength - 2);
    const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/jpeg" }) });
    await service.beginMediaUpload(owner, command({ declaredMimeType: "image/jpeg", declaredByteSize: bytes.byteLength, originalFileName: "large.jpg" }));
    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).resolves.toMatchObject({ asset: { actualMimeType: "image/jpeg" } });
  });

  it("animated WebP 由 ANMF 第一幀驗證，缺少幀資料則拒絕", async () => {
    for (const [bytes, succeeds] of [[animatedWebp(), true], [animatedWebp({ codec: "VP8 " }), true], [animatedWebp({ bitstreamCount: 0 }), false]] as const) {
      const key = `${idempotencyKey}-${succeeds}`;
      const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/webp" }) });
      await service.beginMediaUpload(owner, { ...command({ declaredMimeType: "image/webp", declaredByteSize: bytes.byteLength, originalFileName: "animated.webp" }), idempotencyKey: key });
      const finalize = service.finalizeMediaUpload(owner, { idempotencyKey: key });
      if (succeeds) await expect(finalize).resolves.toMatchObject({ asset: { actualMimeType: "image/webp", width: 2, height: 3 } });
      else await expect(finalize).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
    }
  });

  it("拒絕 VP8L 三位元版本值為 7 的 26-byte WebP", async () => {
    const bytes = webp();
    bytes[24] |= 0xe0;
    const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/webp" }) });
    await service.beginMediaUpload(owner, command({ declaredMimeType: "image/webp", declaredByteSize: bytes.byteLength, originalFileName: "vp8l-version-7.webp" }));

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("拒絕宣告 animation 卻缺少 ANIM chunk 的 WebP", async () => {
    const bytes = animatedWebp({ includeAnim: false });
    const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/webp" }) });
    await service.beginMediaUpload(owner, command({ declaredMimeType: "image/webp", declaredByteSize: bytes.byteLength, originalFileName: "missing-anim.webp" }));

    await expect(service.finalizeMediaUpload(owner, { idempotencyKey })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
  });

  it("animated WebP 拒絕超過像素上限、尺寸不符或多重 image bitstream 的 ANMF", async () => {
    const invalid = [
      animatedWebp({ bitstreamWidth: 16_384, bitstreamHeight: 16_384 }),
      animatedWebp({ bitstreamWidth: 2, bitstreamHeight: 1 }),
      animatedWebp({ bitstreamCount: 2 }),
      animatedWebp({ codec: "VP8 ", bitstreamWidth: 1, bitstreamHeight: 3 }),
    ];
    for (const [index, bytes] of invalid.entries()) {
      const key = `${idempotencyKey}-invalid-anmf-${index}`;
      const service = createMediaService({ store: createInMemoryMediaStore({ activeGameIds: [gameId] }), objects: objectStore({ bytes, mimeType: "image/webp" }) });
      await service.beginMediaUpload(owner, { ...command({ declaredMimeType: "image/webp", declaredByteSize: bytes.byteLength, originalFileName: "animated.webp" }), idempotencyKey: key });
      await expect(service.finalizeMediaUpload(owner, { idempotencyKey: key })).rejects.toBeInstanceOf(MediaStoredObjectInvalidError);
    }
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

    expect(result).not.toEqual({ status: "finalizing" });
    if ("status" in result) throw new Error("expected finalized upload");
    expect(result.asset.actualMimeType).toBe("application/octet-stream");
    expect(result.thumbnail).toBeNull();
  });

  it("相簿公開介面可更新說明、選用人工封面並恢復來源封面", async () => {
    const store = createInMemoryMediaStore({ activeGameIds: [gameId] });
    const service = createMediaService({ store, objects: objectStore({ bytes: png(), mimeType: "image/png" }) });
    await service.beginMediaUpload(owner, command());
    const finalized = await service.finalizeMediaUpload(owner, { idempotencyKey });
    if ("status" in finalized) throw new Error("expected finalized upload");

    await expect(service.updateMediaMetadata(owner, { assetId: finalized.asset.id, caption: "  桌遊夜  " }))
      .resolves.toMatchObject({ caption: "桌遊夜" });
    await expect(service.selectManualCover(owner, { gameId, assetId: finalized.asset.id }))
      .resolves.toEqual({ manualCoverAssetId: finalized.asset.id });
    await expect(service.listGameMedia(owner, { gameId })).resolves.toMatchObject({
      gameId, manualCoverAssetId: finalized.asset.id,
      items: [{ asset: { id: finalized.asset.id, caption: "桌遊夜" }, thumbnailUrl: null }],
    });
    await expect(service.useSourceCover(owner, { gameId })).resolves.toEqual({ manualCoverAssetId: null });
    await expect(service.listGameMedia(owner, { gameId })).resolves.toMatchObject({ manualCoverAssetId: null });
  });
});

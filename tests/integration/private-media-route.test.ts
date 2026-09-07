import { describe, expect, it, vi } from "vitest";
import { createPrivateMediaHandlers } from "@/app/api/private/media/_handlers";
import type { MediaService } from "@/modules/media";
import { MediaAssetUnavailableError, MediaStoredObjectInvalidError, MediaStorageUnavailableError, MediaUploadIdempotencyConflictError } from "@/modules/media";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";

const owner = { sub: "owner-subject" };
const requestId = "44444444-4444-4444-8444-444444444444";
const gameId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";

function setup() {
  const service: MediaService = {
    beginMediaUpload: vi.fn<MediaService["beginMediaUpload"]>(async () => ({
      status: "upload_grant", ingestId: key, assetId,
      upload: {
        protocol: "tus", endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable/sign",
        headers: { "x-signature": "opaque" }, metadata: { bucketName: "game-media", objectName: `originals/${assetId}/opaque`, contentType: "image/png", cacheControl: "0" },
        declaredByteSize: 123, maxByteSize: 52_428_800, chunkSize: 6_291_456,
        retryDelays: [0, 3_000, 5_000, 10_000, 20_000], uploadDataDuringCreation: true, resumeFromPreviousUpload: true, removeFingerprintOnSuccess: true, upsert: false,
        fingerprint: `puizeru:${key}:originals/${assetId}/opaque`,
      }, expiresAt: "2026-09-06T02:00:00.000Z",
    })),
    finalizeMediaUpload: vi.fn<MediaService["finalizeMediaUpload"]>(async () => ({ status: "finalizing" })),
    retryThumbnail: vi.fn<MediaService["retryThumbnail"]>(async () => ({ assetId, spec: "thumb_webp_v1", state: "pending" })),
    issueOriginalRead: vi.fn<MediaService["issueOriginalRead"]>(async () => ({ status: "original_read", url: "https://storage.example/signed?token=opaque&download=photo.png", expiresAt: "2026-09-06T00:01:00.000Z", disposition: "attachment" })),
    listGameMedia: vi.fn<MediaService["listGameMedia"]>(async () => ({ gameId, manualCoverAssetId: null, sourceCover: null, items: [] })),
    updateMediaMetadata: vi.fn<MediaService["updateMediaMetadata"]>(async () => ({ id: assetId, gameId, purpose: "attachment", originalFileName: "rules.pdf", actualMimeType: "application/pdf", byteSize: 123, width: null, height: null, removedAt: null, createdAt: "2026-09-06T00:00:00.000Z", caption: null, displayName: "規則書", description: "遊戲規則" })),
    selectManualCover: vi.fn<MediaService["selectManualCover"]>(async () => ({ manualCoverAssetId: assetId })),
    useSourceCover: vi.fn<MediaService["useSourceCover"]>(async () => ({ manualCoverAssetId: null })),
  };
  const verifyAccessToken = vi.fn(async () => owner);
  const onUnhandledFailure = vi.fn();
  return {
    service,
    handlers: createPrivateMediaHandlers({ service, verifyAccessToken, onAccessDenied: vi.fn(), onUnhandledFailure }),
    verifyAccessToken,
    onUnhandledFailure,
  };
}

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://games.example.test${path}`, {
    method: body === undefined ? "OPTIONS" : "POST",
    headers: { origin: "https://games.example.test", "content-type": "application/json", "x-request-id": requestId, "Cf-Access-Jwt-Assertion": "owner-token", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("private media routes", () => {
  it("未授權 begin 在 MediaService／Storage／DB 前拒絕", async () => {
    const { handlers, service, verifyAccessToken } = setup();
    vi.mocked(verifyAccessToken).mockRejectedValueOnce(new AccessDeniedError());

    const response = await handlers.begin(request("/api/private/media/uploads/begin", { idempotencyKey: key, gameId, purpose: "gallery_image", originalFileName: "photo.png", declaredMimeType: "image/png", declaredByteSize: 123 }));

    expect(response.status).toBe(401);
    expect(service.beginMediaUpload).not.toHaveBeenCalled();
  });

  it("未授權的附件說明與封面變更在 MediaService 前拒絕", async () => {
    const { handlers, service, verifyAccessToken } = setup();
    vi.mocked(verifyAccessToken).mockRejectedValue(new AccessDeniedError());
    expect((await handlers.metadata(request(`/api/private/media/assets/${assetId}/metadata`, { description: "私有內容" }), assetId)).status).toBe(401);
    expect((await handlers.cover(request(`/api/private/media/games/${gameId}/cover`, { mode: "manual", assetId }), gameId)).status).toBe(401);
    expect(service.updateMediaMetadata).not.toHaveBeenCalled();
    expect(service.selectManualCover).not.toHaveBeenCalled();
  });

  it("同源 CORS preflight 不驗 owner 且宣告 POST headers", async () => {
    const { handlers, service, verifyAccessToken } = setup();
    const response = handlers.options(request("/api/private/media/uploads/begin"));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://games.example.test");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("Cf-Access-Jwt-Assertion");
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(service.beginMediaUpload).not.toHaveBeenCalled();
  });

  it("拒絕跨源 preflight，且 malformed／超限 payload 不呼叫 service", async () => {
    const { handlers, service } = setup();
    expect(handlers.options(request("/api/private/media/uploads/begin", undefined, { origin: "https://evil.example" })).status).toBe(403);
    const malformed = await handlers.begin(request("/api/private/media/uploads/begin", { idempotencyKey: key, gameId, purpose: "gallery_image", originalFileName: "photo.png", declaredMimeType: "image/png", declaredByteSize: 52_428_801 }));
    expect(malformed.status).toBe(400);
    expect(service.beginMediaUpload).not.toHaveBeenCalled();
  });

  it("begin、finalize 與 original read 只回最小私有 payload，不記錄 capability", async () => {
    const { handlers, service } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const begin = await handlers.begin(request("/api/private/media/uploads/begin", { idempotencyKey: key, gameId, purpose: "gallery_image", originalFileName: "photo.png", declaredMimeType: "image/png", declaredByteSize: 123 }));
    const finalize = await handlers.finalize(request("/api/private/media/uploads/finalize", { idempotencyKey: key }));
    const original = await handlers.original(request(`/api/private/media/assets/${assetId}/original`, { assetId }), assetId);

    expect([begin.status, finalize.status, original.status]).toEqual([200, 200, 200]);
    expect(begin.headers.get("cache-control")).toBe("private, no-store");
    expect(await original.json()).toMatchObject({ disposition: "attachment", url: expect.stringContaining("download=") });
    expect(service.finalizeMediaUpload).toHaveBeenCalledWith(owner, { idempotencyKey: key });
    expect(service.issueOriginalRead).toHaveBeenCalledWith(owner, { assetId });
    expect([...warn.mock.calls, ...error.mock.calls].flat().join(" ")).not.toContain("opaque");
    warn.mockRestore(); error.mockRestore();
  });

  it("相簿、附件說明、縮圖重試與封面切換皆由同一私有邊界轉交公開 MediaService", async () => {
    const { handlers, service } = setup();
    expect((await handlers.list(request(`/api/private/media/games/${gameId}`, {}), gameId)).status).toBe(200);
    expect((await handlers.metadata(request(`/api/private/media/assets/${assetId}/metadata`, { displayName: "規則書", description: "中文版" }), assetId)).status).toBe(200);
    expect((await handlers.cover(request(`/api/private/media/games/${gameId}/cover`, { mode: "manual", assetId }), gameId)).status).toBe(200);
    expect((await handlers.cover(request(`/api/private/media/games/${gameId}/cover`, { mode: "source" }), gameId)).status).toBe(200);
    expect((await handlers.retryThumbnail(request(`/api/private/media/assets/${assetId}/retry-thumbnail`, {}), assetId)).status).toBe(200);
    expect(service.listGameMedia).toHaveBeenCalledWith(owner, { gameId });
    expect(service.updateMediaMetadata).toHaveBeenCalledWith(owner, { assetId, displayName: "規則書", description: "中文版" });
    expect(service.selectManualCover).toHaveBeenCalledWith(owner, { gameId, assetId });
    expect(service.useSourceCover).toHaveBeenCalledWith(owner, { gameId });
    expect(service.retryThumbnail).toHaveBeenCalledWith(owner, { assetId });
  });

  it("Storage failure 保留具名觀測碼，但回應與 log 不含 provider 細節", async () => {
    const { handlers, service, onUnhandledFailure } = setup();
    vi.mocked(service.issueOriginalRead).mockRejectedValueOnce(new MediaStorageUnavailableError());
    const response = await handlers.original(request(`/api/private/media/assets/${assetId}/original`, { assetId }), assetId);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "媒體儲存服務暫時無法使用，請重試。", requestId });
    expect(onUnhandledFailure).toHaveBeenCalledWith({ errorCode: "media_storage_unavailable", requestId });
  });

  it("預期的 400／404／409 media domain errors 不回報為 server failure", async () => {
    const { handlers, service, onUnhandledFailure } = setup();
    vi.mocked(service.beginMediaUpload).mockRejectedValueOnce(new MediaStoredObjectInvalidError());
    expect((await handlers.begin(request("/api/private/media/uploads/begin", { idempotencyKey: key, gameId, purpose: "gallery_image", originalFileName: "photo.png", declaredMimeType: "image/png", declaredByteSize: 123 }))).status).toBe(400);
    vi.mocked(service.issueOriginalRead).mockRejectedValueOnce(new MediaAssetUnavailableError());
    expect((await handlers.original(request(`/api/private/media/assets/${assetId}/original`, { assetId }), assetId)).status).toBe(404);
    vi.mocked(service.beginMediaUpload).mockRejectedValueOnce(new MediaUploadIdempotencyConflictError());
    expect((await handlers.begin(request("/api/private/media/uploads/begin", { idempotencyKey: key, gameId, purpose: "gallery_image", originalFileName: "photo.png", declaredMimeType: "image/png", declaredByteSize: 123 }))).status).toBe(409);
    expect(onUnhandledFailure).not.toHaveBeenCalled();
  });
});

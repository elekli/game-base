import { describe, expect, it, vi } from "vitest";
import { SupabaseMediaObjectStore } from "@/adapters/supabase-media-object-store";
import { MediaStorageUnavailableError } from "@/modules/media";

describe("Supabase media Storage adapter", () => {
  const path = "originals/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  it("只用 server credential 簽發不可覆寫的 path token 與 direct TUS endpoint", async () => {
    const createSignedUploadUrl = vi.fn(async () => ({ data: { path, token: "signed-path-token", signedUrl: "https://ignored" }, error: null }));
    const adapter = new SupabaseMediaObjectStore({
      supabaseUrl: "https://project.supabase.co",
      bucket: "game-media",
      files: { createSignedUploadUrl } as never,
    });

    const result = await adapter.createUploadGrant(path);

    expect(createSignedUploadUrl).toHaveBeenCalledWith(path, { upsert: false });
    expect(result).toEqual({
      uploadUrl: "https://project.storage.supabase.co/storage/v1/upload/resumable",
      token: "signed-path-token",
      expiresAt: expect.any(String),
    });
  });

  it("signed original 固定 60 秒並要求 attachment filename", async () => {
    const signedUrl = `https://project.supabase.co/storage/v1/object/sign/game-media/${path}?${new URLSearchParams({ token: "opaque", download: "相片.png" })}`;
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl }, error: null }));
    const adapter = new SupabaseMediaObjectStore({
      supabaseUrl: "https://project.supabase.co",
      bucket: "game-media",
      files: { createSignedUrl } as never,
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await expect(adapter.createOriginalReadGrant(path, "相片.png", 60)).resolves.toEqual({
      url: signedUrl,
      expiresAt: "2026-09-06T00:01:00.000Z",
    });
    expect(createSignedUrl).toHaveBeenCalledWith(path, 60, { download: "相片.png" });
  });

  it.each([
    ["evil origin", `https://evil.example/storage/v1/object/sign/game-media/${path}?token=x&download=${encodeURIComponent("相片.png")}`],
    ["wrong bucket", `https://project.supabase.co/storage/v1/object/sign/public/${path}?token=x&download=${encodeURIComponent("相片.png")}`],
    ["wrong path", `https://project.supabase.co/storage/v1/object/sign/game-media/${path}-other?token=x&download=${encodeURIComponent("相片.png")}`],
    ["wrong filename", `https://project.supabase.co/storage/v1/object/sign/game-media/${path}?token=x&download=${encodeURIComponent("別人的.png")}`],
  ])("signed original 拒絕 malformed provider URL：%s", async (_case, signedUrl) => {
    const adapter = new SupabaseMediaObjectStore({
      supabaseUrl: "https://project.supabase.co", bucket: "game-media",
      files: { createSignedUrl: vi.fn(async () => ({ data: { signedUrl }, error: null })) } as never,
    });
    await expect(adapter.createOriginalReadGrant(path, "相片.png", 60)).rejects.toBeInstanceOf(MediaStorageUnavailableError);
  });

  it("info response 必須回傳 exact object path，拒絕 basename 或其它物件", async () => {
    const valid = new SupabaseMediaObjectStore({ supabaseUrl: "https://project.supabase.co", bucket: "game-media", files: { info: vi.fn(async () => ({ data: { name: path, size: 42, contentType: "image/png" }, error: null })) } as never });
    await expect(valid.inspect(path)).resolves.toEqual({ path, byteSize: 42, mimeType: "image/png" });
    for (const name of [path.split("/").at(-1), `${path}-other`, "../secret"]) {
      const malformed = new SupabaseMediaObjectStore({ supabaseUrl: "https://project.supabase.co", bucket: "game-media", files: { info: vi.fn(async () => ({ data: { name, size: 42, contentType: "image/png" }, error: null })) } as never });
      await expect(malformed.inspect(path)).rejects.toBeInstanceOf(MediaStorageUnavailableError);
    }
  });

  it("provider error 轉為具名 Storage failure，且不洩漏原始訊息", async () => {
    const adapter = new SupabaseMediaObjectStore({
      supabaseUrl: "https://project.supabase.co",
      bucket: "game-media",
      files: { createSignedUploadUrl: vi.fn(async () => ({ data: null, error: new Error("secret raw response") })) } as never,
    });

    await expect(adapter.createUploadGrant(path)).rejects.toEqual(expect.objectContaining({
      name: "MediaStorageUnavailableError",
      code: "media_storage_unavailable",
      message: "媒體儲存服務暫時無法使用，請重試。",
    }));
    await expect(adapter.createUploadGrant(path)).rejects.toBeInstanceOf(MediaStorageUnavailableError);
  });

  it("拒絕 traversal、非保留 UUID path 與 provider 回傳的錯誤 path", async () => {
    const createSignedUploadUrl = vi.fn(async () => ({ data: { path: `${path}/different`, token: "token", signedUrl: "https://ignored" }, error: null }));
    const adapter = new SupabaseMediaObjectStore({ supabaseUrl: "https://project.supabase.co", bucket: "game-media", files: { createSignedUploadUrl } as never });
    await expect(adapter.createUploadGrant("originals/../../secrets")).rejects.toBeInstanceOf(MediaStorageUnavailableError);
    await expect(adapter.createUploadGrant(path)).rejects.toBeInstanceOf(MediaStorageUnavailableError);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ExternalThumbnailObjectStore } from "./external-thumbnail-object-store";
import { ExternalReferenceThumbnailUnavailableError } from "@/modules/lists/external-reference-thumbnail";

const objectKey = `external-reference-thumbnails/11111111-1111-4111-8111-111111111111/${"a".repeat(64)}.webp`;

describe("ExternalThumbnailObjectStore", () => {
  it("uploads WebP bytes to the private bucket with an idempotent object key", async () => {
    const upload = vi.fn(async (path: string) => ({ data: { path }, error: null as null }));
    const store = new ExternalThumbnailObjectStore({ supabaseUrl: "https://project.supabase.co", files: { upload, createSignedUrl: vi.fn() } as never });
    await store.upload(objectKey, new Uint8Array([1]));
    expect(upload).toHaveBeenCalledWith(objectKey, expect.any(Uint8Array), { contentType: "image/webp", upsert: true, cacheControl: "0" });
    await expect(store.upload("../public.webp", new Uint8Array([1]))).rejects.toBeInstanceOf(ExternalReferenceThumbnailUnavailableError);
  });

  it("accepts only the exact private signed URL shape", async () => {
    const signedUrl = `https://project.supabase.co/storage/v1/object/sign/game-media/${objectKey}?token=opaque`;
    const store = new ExternalThumbnailObjectStore({ supabaseUrl: "https://project.supabase.co", files: { upload: vi.fn(), createSignedUrl: vi.fn(async () => ({ data: { signedUrl }, error: null as null })) } as never });
    await expect(store.issueRead(objectKey)).resolves.toBe(signedUrl);
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MediaStorageUnavailableError, MediaThumbnailUnsupportedError } from "./errors";
import { transformThumbnail } from "./thumbnail-transform";

async function* bytesOf(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

describe("thumb_webp_v1 真實 raster 轉換", () => {
  it("轉正 EXIF、保留 alpha、移除 metadata，並限制長邊但不放大", async () => {
    const oriented = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .withMetadata({ orientation: 6 }).png().toBuffer();
    const small = await transformThumbnail(bytesOf(oriented));
    const smallMetadata = await sharp(small.bytes).metadata();
    expect({ width: small.width, height: small.height, format: smallMetadata.format, hasAlpha: smallMetadata.hasAlpha, orientation: smallMetadata.orientation, exif: smallMetadata.exif }).toEqual({
      width: 10, height: 20, format: "webp", hasAlpha: true, orientation: undefined, exif: undefined,
    });

    const wide = await sharp({ create: { width: 1_280, height: 320, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    await expect(transformThumbnail(bytesOf(wide))).resolves.toMatchObject({ width: 640, height: 160 });
  });

  it("無法解碼的內容給具名且不含來源內容的錯誤", async () => {
    await expect(transformThumbnail(bytesOf(new TextEncoder().encode("not-a-raster")))).rejects.toBeInstanceOf(MediaThumbnailUnsupportedError);
  });

  it("來源串流的暫時 Storage failure 不被誤判為內容不支援", async () => {
    async function* unavailable(): AsyncIterable<Uint8Array> { throw new MediaStorageUnavailableError(); }
    await expect(transformThumbnail(unavailable())).rejects.toBeInstanceOf(MediaStorageUnavailableError);
  });
});

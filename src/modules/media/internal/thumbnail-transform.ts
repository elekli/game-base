import sharp from "sharp";
import { MEDIA_MAX_BYTES } from "../file-size-policy";
import { MediaThumbnailUnsupportedError } from "./errors";
import { MEDIA_MAX_PIXELS } from "./types";

export type ThumbnailTransform = Readonly<{ bytes: Uint8Array; width: number; height: number }>;

async function readAll(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > MEDIA_MAX_BYTES) throw new MediaThumbnailUnsupportedError();
    chunks.push(Buffer.from(chunk));
  }
  if (length === 0) throw new MediaThumbnailUnsupportedError();
  return Buffer.concat(chunks, length);
}

/** 只轉出固定 v1 衍生物；不回寫原檔、也不保留輸入 metadata。 */
export async function transformThumbnail(source: AsyncIterable<Uint8Array>): Promise<ThumbnailTransform> {
  const input = await readAll(source);
  try {
    const output = await sharp(input, { animated: false, limitInputPixels: MEDIA_MAX_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (output.info.format !== "webp" || output.info.width <= 0 || output.info.height <= 0 || output.data.byteLength <= 0) throw new MediaThumbnailUnsupportedError();
    return { bytes: new Uint8Array(output.data), width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof MediaThumbnailUnsupportedError) throw error;
    throw new MediaThumbnailUnsupportedError();
  }
}

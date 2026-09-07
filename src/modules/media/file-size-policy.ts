import { MediaFileEmptyError, MediaFileTooLargeError } from "./internal/errors";

/** 共用於瀏覽器選檔回饋、begin 與 finalize；Storage／DB 另有相同硬限制。 */
export const MEDIA_MAX_BYTES = 52_428_800;

export function assertMediaFileSize(byteSize: number): void {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new MediaFileEmptyError();
  if (byteSize > MEDIA_MAX_BYTES) throw new MediaFileTooLargeError();
}

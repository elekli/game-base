import { NamedError } from "@/shared/errors/named-error";

export class MediaOperationError extends NamedError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MediaOperationError";
  }
}

export class MediaFileEmptyError extends MediaOperationError {
  constructor() { super("media_file_empty", "媒體原檔不可為空。"); this.name = "MediaFileEmptyError"; }
}

export class MediaFileTooLargeError extends MediaOperationError {
  constructor() { super("media_file_too_large", "媒體原檔不可超過 50 MiB。"); this.name = "MediaFileTooLargeError"; }
}

export class MediaUploadIdempotencyConflictError extends MediaOperationError {
  constructor() { super("media_upload_idempotency_conflict", "此媒體冪等鍵已用於不同原檔。"); this.name = "MediaUploadIdempotencyConflictError"; }
}

export class MediaGameUnavailableError extends MediaOperationError {
  constructor() { super("media_game_unavailable", "找不到可新增媒體的遊戲條目。"); this.name = "MediaGameUnavailableError"; }
}

export class MediaUploadIncompleteError extends MediaOperationError {
  constructor() { super("media_upload_incomplete", "媒體原檔尚未完整寫入。"); this.name = "MediaUploadIncompleteError"; }
}

export class MediaStoredObjectInvalidError extends MediaOperationError {
  constructor() { super("media_stored_object_invalid", "媒體原檔內容無法安全使用。"); this.name = "MediaStoredObjectInvalidError"; }
}

export class MediaFinalizeUnavailableError extends MediaOperationError {
  constructor() { super("media_finalize_unavailable", "媒體完成確認暫時無法執行，請重試。"); this.name = "MediaFinalizeUnavailableError"; }
}

export class MediaBeginUnavailableError extends MediaOperationError {
  constructor() { super("media_begin_unavailable", "媒體上傳暫時無法開始，請重試。"); this.name = "MediaBeginUnavailableError"; }
}

export class MediaStorageQuotaExceededError extends MediaOperationError {
  constructor() { super("media_storage_quota_exceeded", "媒體儲存空間已達安全上限，暫停新增檔案。"); this.name = "MediaStorageQuotaExceededError"; }
}

export class MediaAssetUnavailableError extends MediaOperationError {
  constructor() { super("media_asset_unavailable", "找不到可讀取的媒體原檔。"); this.name = "MediaAssetUnavailableError"; }
}

export class MediaStorageUnavailableError extends MediaOperationError {
  constructor() { super("media_storage_unavailable", "媒體儲存服務暫時無法使用，請重試。"); this.name = "MediaStorageUnavailableError"; }
}

export class MediaReadUnavailableError extends MediaOperationError {
  constructor() { super("media_read_unavailable", "媒體原檔暫時無法授權讀取，請重試。"); this.name = "MediaReadUnavailableError"; }
}

export class MediaThumbnailUnsupportedError extends MediaOperationError {
  constructor() { super("media_thumbnail_unsupported", "媒體原檔已儲存，但無法建立縮圖。"); this.name = "MediaThumbnailUnsupportedError"; }
}

export class MediaThumbnailUnavailableError extends MediaOperationError {
  constructor() { super("media_thumbnail_unavailable", "媒體縮圖暫時無法建立，系統將重試。"); this.name = "MediaThumbnailUnavailableError"; }
}

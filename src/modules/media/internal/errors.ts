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

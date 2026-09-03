import { NamedError } from "@/shared/errors/named-error";

export type SourceErrorCode =
  | "source_query_invalid"
  | "source_not_found"
  | "source_rate_limited"
  | "source_unavailable"
  | "source_authentication_failed"
  | "source_authentication_unavailable"
  | "source_response_invalid"
  | "source_content_changed"
  | "source_identity_conflict"
  | "source_medium_mismatch"
  | "source_not_linked"
  | "source_persistence_failed";

export class SourceOperationError extends NamedError {
  constructor(
    public readonly sourceCode: SourceErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(sourceCode, message);
    this.name = "SourceOperationError";
  }
}

export class SourceQueryInvalidError extends SourceOperationError {
  constructor() { super("source_query_invalid", "搜尋條件無效。後續未呼叫來源。"); this.name = "SourceQueryInvalidError"; }
}
export class SourceNotFoundError extends SourceOperationError {
  constructor() { super("source_not_found", "找不到來源項目。", null); this.name = "SourceNotFoundError"; }
}
export class SourceRateLimitedError extends SourceOperationError {
  constructor(retryAfterSeconds: number | null = null) { super("source_rate_limited", "來源目前忙碌，請稍後再試。", retryAfterSeconds); this.name = "SourceRateLimitedError"; }
}
export class SourceUnavailableError extends SourceOperationError {
  constructor() { super("source_unavailable", "來源暫時無法使用，請稍後再試。", null); this.name = "SourceUnavailableError"; }
}
export class SourceAuthenticationFailedError extends SourceOperationError {
  constructor() { super("source_authentication_failed", "來源驗證設定無效。", null); this.name = "SourceAuthenticationFailedError"; }
}
export class SourceAuthenticationUnavailableError extends SourceOperationError {
  constructor() { super("source_authentication_unavailable", "來源驗證服務暫時無法使用。", null); this.name = "SourceAuthenticationUnavailableError"; }
}
export class SourceResponseInvalidError extends SourceOperationError {
  constructor() { super("source_response_invalid", "來源回應無法安全使用。", null); this.name = "SourceResponseInvalidError"; }
}
export class SourceContentChangedError extends SourceOperationError {
  constructor(public readonly latest: unknown) { super("source_content_changed", "來源資料已更新，請重新確認。", null); this.name = "SourceContentChangedError"; }
}
export class SourceIdentityConflictError extends SourceOperationError {
  constructor(public readonly gameId: string, public readonly trashed: boolean) { super("source_identity_conflict", trashed ? "此來源已存在於資源回收區，請先還原。" : "此來源已存在於收藏庫。", null); this.name = "SourceIdentityConflictError"; }
}
export class SourceMediumMismatchError extends SourceOperationError {
  constructor() { super("source_medium_mismatch", "來源遊戲類型與目前條目不相容。", null); this.name = "SourceMediumMismatchError"; }
}
export class SourceNotLinkedError extends SourceOperationError {
  constructor() { super("source_not_linked", "此遊戲尚未連結外部來源。", null); this.name = "SourceNotLinkedError"; }
}
export class SourcePersistenceFailedError extends SourceOperationError {
  constructor() { super("source_persistence_failed", "來源資料無法儲存，請稍後再試。", null); this.name = "SourcePersistenceFailedError"; }
}

export type MediaReconcileEvent = Readonly<{
  event: "media_reconcile_completed" | "media_reconcile_skipped" | "media_reconcile_failed" | "media_cleanup_completed" | "media_cleanup_failed" | "media_quota_warning" | "media_quota_stop_writes";
  level: "info" | "warn" | "error";
  operation: "media_reconcile" | "media_cleanup" | "media_quota";
  errorCode: string | null;
  resourceType: "media";
  resourceId: null;
  attempt: number | null;
  durationMs: null;
}>;

export type MediaReconcileEventInput = Readonly<{
  status: "completed" | "skipped" | "failed";
  thumbnailsWoken: number;
  cleanupCleaned: number;
  cleanupFailed: number;
  quotaState: "ok" | "warning" | "stop_writes";
}>;

export function mediaReconcileEvents(input: MediaReconcileEventInput & Readonly<Record<string, unknown>>): readonly MediaReconcileEvent[] {
  const events: MediaReconcileEvent[] = [];
  events.push({
    event: input.status === "completed" ? "media_reconcile_completed" : input.status === "skipped" ? "media_reconcile_skipped" : "media_reconcile_failed",
    level: input.status === "failed" ? "error" : input.status === "skipped" ? "info" : "info",
    operation: "media_reconcile",
    errorCode: input.status === "failed" ? "media_reconcile_unavailable" : null,
    resourceType: "media",
    resourceId: null,
    attempt: null,
    durationMs: null,
  });
  if (input.cleanupCleaned > 0) events.push({ event: "media_cleanup_completed", level: "info", operation: "media_cleanup", errorCode: null, resourceType: "media", resourceId: null, attempt: input.cleanupCleaned, durationMs: null });
  if (input.cleanupFailed > 0) events.push({ event: "media_cleanup_failed", level: "warn", operation: "media_cleanup", errorCode: "media_cleanup_unavailable", resourceType: "media", resourceId: null, attempt: input.cleanupFailed, durationMs: null });
  if (input.quotaState === "warning" || input.quotaState === "stop_writes") events.push({ event: input.quotaState === "warning" ? "media_quota_warning" : "media_quota_stop_writes", level: "warn", operation: "media_quota", errorCode: input.quotaState === "warning" ? "media_quota_warning" : "media_quota_stop_writes", resourceType: "media", resourceId: null, attempt: null, durationMs: null });
  return events;
}

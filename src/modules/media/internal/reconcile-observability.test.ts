import { describe, expect, it } from "vitest";
import { mediaReconcileEvents } from "./reconcile-observability";
import { serializeBootstrapLogEvent, serializeLogEvent } from "@/shared/observability/structured-log";

describe("媒體 reconcile 可觀測性", () => {
  it("只產生命名事件與 allowlist 欄位，並遮蔽 Storage capability 與路徑", () => {
    const events = mediaReconcileEvents({
      status: "completed",
      thumbnailsWoken: 2,
      cleanupCleaned: 1,
      cleanupFailed: 1,
      quotaState: "warning",
      requestId: "11111111-1111-4111-8111-111111111111",
      secret: "sb_secret_must_not_appear",
      signedUrl: "https://storage.example.test/signed?token=must-not-appear",
      authorization: "Bearer must-not-appear",
      cookie: "must-not-appear",
      objectPath: "thumbnails/private/path.webp",
    });

    expect(events.map((event) => event.event)).toEqual([
      "media_reconcile_completed",
      "media_cleanup_completed",
      "media_cleanup_failed",
      "media_quota_warning",
    ]);
    expect(JSON.stringify(events)).not.toContain("must-not-appear");
    expect(JSON.stringify(events)).not.toContain("thumbnails/private");
  });

  it("經過兩個實際 serializer 後仍剝除 capability、路徑與 header extras", () => {
    const unsafe = { event: "media_reconcile_completed", level: "info" as const, requestId: "11111111-1111-4111-8111-111111111111", operation: "media_reconcile", errorCode: null, resourceType: "media" as const, resourceId: null, attempt: 1, durationMs: null, environment: "preview" as const, authorization: "Bearer secret", cookie: "cookie", objectPath: "thumbnails/private.webp", signedUrl: "https://x/?token=secret" };
    for (const output of [serializeLogEvent(unsafe), serializeBootstrapLogEvent(unsafe)]) {
      expect(output).not.toMatch(/secret|cookie|thumbnails\/private|signedUrl|authorization/i);
    }
  });
});

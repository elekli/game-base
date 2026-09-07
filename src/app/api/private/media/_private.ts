import { getRuntimeConfig } from "@/shared/config/get-runtime-config";
import { getProductionAccessTokenVerifier } from "@/shared/auth/production-access-token-verifier";
import { serializeBootstrapLogEvent } from "@/shared/observability/structured-log";
import { serializeLogEvent } from "@/shared/observability/structured-log";
import { mediaReconcileEvents } from "@/modules/media/internal/reconcile-observability";
import type { MediaReconcileResult } from "@/modules/media/internal/types";
import { mediaService } from "@/app/media/service";

export function getPrivateMediaDependencies() {
  const config = getRuntimeConfig();
  const onReconcile = ({ requestId, result }: Readonly<{ requestId: string; result: MediaReconcileResult }>) => {
    for (const event of mediaReconcileEvents(result)) {
      const output = config.environment === "preview" || config.environment === "production"
        ? serializeLogEvent({ ...event, requestId, environment: config.environment })
        : serializeBootstrapLogEvent({ ...event, requestId });
      if (event.level === "error") console.error(output);
      else if (event.level === "warn") console.warn(output);
      else console.info(output);
    }
  };
  return {
    verifyAccessToken: getProductionAccessTokenVerifier(config.cloudflare),
    onAccessDenied: ({ requestId }: { requestId: string }) => console.warn(serializeBootstrapLogEvent({ event: "access_denied", level: "warn", requestId, operation: "media", errorCode: "access_denied", resourceType: "media", resourceId: null, attempt: null, durationMs: null })),
    onUnhandledFailure: ({ requestId, errorCode }: { requestId: string; errorCode: string }) => console.error(serializeBootstrapLogEvent({ event: "private_operation_failed", level: "error", requestId, operation: "media", errorCode, resourceType: "media", resourceId: null, attempt: null, durationMs: null })),
    reconcileMedia: mediaService.reconcileMedia,
    onReconcile,
  } as const;
}

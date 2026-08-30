import { getRuntimeConfig } from "@/shared/config/get-runtime-config";
import { getProductionAccessTokenVerifier } from "@/shared/auth/production-access-token-verifier";
import { serializeBootstrapLogEvent } from "@/shared/observability/structured-log";

export function getPrivateDependencies() {
  const config = getRuntimeConfig();
  return {
    verifyAccessToken: getProductionAccessTokenVerifier(config.cloudflare),
    onAccessDenied: ({ requestId }: { requestId: string }) => console.warn(serializeBootstrapLogEvent({ event: "access_denied", level: "warn", requestId, operation: "games", errorCode: "access_denied", resourceType: null, resourceId: null, attempt: null, durationMs: null })),
    onUnhandledFailure: ({ requestId, errorCode }: { requestId: string; errorCode: string }) => console.error(serializeBootstrapLogEvent({ event: "private_operation_failed", level: "error", requestId, operation: "games", errorCode, resourceType: null, resourceId: null, attempt: null, durationMs: null })),
  } as const;
}

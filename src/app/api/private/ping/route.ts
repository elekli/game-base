import { createRemoteJWKSet } from "jose";
import { handlePrivateRequest } from "@/shared/auth/private-request";
import { createAccessTokenVerifier } from "@/shared/auth/verify-access-token";
import { getRuntimeConfig } from "@/shared/config/get-runtime-config";
import { getRequestId } from "@/shared/observability/request-id";
import { serializeLogEvent } from "@/shared/observability/structured-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const config = getRuntimeConfig();
    const verifyAccessToken = createAccessTokenVerifier({
      ...config.cloudflare,
      jwks: createRemoteJWKSet(new URL(config.cloudflare.jwksUrl)),
    });

    return handlePrivateRequest(request, {
      verifyAccessToken,
      operation: async () => ({ status: "ready" }),
      onAccessDenied: ({ requestId }) => {
        if (config.environment === "development") return;
        console.warn(serializeLogEvent({
          event: "access_jwt_rejected",
          level: "warn",
          requestId,
          operation: "private_ping",
          errorCode: "access_denied",
          resourceType: null,
          resourceId: null,
          attempt: null,
          durationMs: null,
          environment: config.environment,
        }));
      },
    });
  } catch {
    const requestId = getRequestId(request.headers);
    return Response.json(
      { message: "暫時無法完成操作。", requestId },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }
}

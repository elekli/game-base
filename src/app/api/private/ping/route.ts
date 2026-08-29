import { handlePrivateRequest } from "@/shared/auth/private-request";
import { getProductionAccessTokenVerifier } from "@/shared/auth/production-access-token-verifier";
import { getRuntimeConfig } from "@/shared/config/get-runtime-config";
import { RuntimeConfigError } from "@/shared/config/runtime-config";
import { getRequestId } from "@/shared/observability/request-id";
import {
  serializeBootstrapLogEvent,
  serializeLogEvent,
} from "@/shared/observability/structured-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function serializePrivatePingFailure(
  requestId: string,
  errorCode: string,
  environment: string | undefined,
) {
  if (environment === "preview" || environment === "production") {
    return serializeLogEvent({
      event: "private_request_failed",
      level: "error",
      requestId,
      operation: "private_ping",
      errorCode,
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: null,
      environment,
    });
  }

  return serializeBootstrapLogEvent({
    event: "private_request_failed",
    level: "error",
    requestId,
    operation: "private_ping",
    errorCode,
    resourceType: null,
    resourceId: null,
    attempt: null,
    durationMs: null,
  });
}

export async function GET(request: Request) {
  try {
    const config = getRuntimeConfig();
    const verifyAccessToken = getProductionAccessTokenVerifier(config.cloudflare);

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
      onUnhandledFailure: ({ errorCode, requestId }) => {
        console.error(
          serializePrivatePingFailure(requestId, errorCode, config.environment),
        );
      },
    });
  } catch (error) {
    const requestId = getRequestId(request.headers);
    const errorCode =
      error instanceof RuntimeConfigError
        ? error.code
        : "private_route_failed";
    console.error(
      serializePrivatePingFailure(requestId, errorCode, process.env.VERCEL_ENV),
    );
    return Response.json(
      { message: "暫時無法完成操作。", requestId },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }
}

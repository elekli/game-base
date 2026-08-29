import { AccessDeniedError } from "./access-denied-error";
import type { AccessTokenVerifier, OwnerIdentity } from "./verify-access-token";
import { getRequestId } from "@/shared/observability/request-id";

type PrivateRequestDependencies<Result extends object> = Readonly<{
  operation: (owner: OwnerIdentity) => Promise<Result>;
  onAccessDenied?: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  verifyAccessToken: AccessTokenVerifier;
}>;

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

function safeErrorResponse(status: number, message: string, requestId: string) {
  return Response.json(
    { message, requestId },
    { status, headers: PRIVATE_RESPONSE_HEADERS },
  );
}

export async function handlePrivateRequest<Result extends object>(
  request: Request,
  dependencies: PrivateRequestDependencies<Result>,
): Promise<Response> {
  const requestId = getRequestId(request.headers);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");

  if (token === null || token.length === 0) {
    await dependencies.onAccessDenied?.({ requestId });
    return safeErrorResponse(401, "無法驗證存取權限。", requestId);
  }

  try {
    const owner = await dependencies.verifyAccessToken(token);
    const result = await dependencies.operation(owner);
    return Response.json(
      { ...result, requestId },
      { headers: PRIVATE_RESPONSE_HEADERS },
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      await dependencies.onAccessDenied?.({ requestId });
      return safeErrorResponse(401, error.message, requestId);
    }
    return safeErrorResponse(500, "暫時無法完成操作。", requestId);
  }
}

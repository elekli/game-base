import { AccessDeniedError } from "./access-denied-error";
import { PrivateOperationFailedError } from "./private-operation-failed-error";
import { requireOwner } from "./require-owner";
import type { AccessTokenVerifier, OwnerIdentity } from "./verify-access-token";
import { getRequestId } from "@/shared/observability/request-id";

type PrivateRequestDependencies<Result extends object> = Readonly<{
  operation: (owner: OwnerIdentity) => Promise<Result>;
  onAccessDenied?: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  onUnhandledFailure?: (
    context: Readonly<{ errorCode: string; requestId: string }>,
  ) => void | Promise<void>;
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
  try {
    const owner = await requireOwner(request.headers, dependencies.verifyAccessToken);
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
    const operationError = new PrivateOperationFailedError();
    await dependencies.onUnhandledFailure?.({
      errorCode: operationError.code,
      requestId,
    });
    return safeErrorResponse(500, operationError.message, requestId);
  }
}

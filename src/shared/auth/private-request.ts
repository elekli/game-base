import { AccessDeniedError } from "./access-denied-error";
import { FailureObserverFailedError } from "./failure-observer-failed-error";
import { PrivateOperationFailedError } from "./private-operation-failed-error";
import { requireOwner } from "./require-owner";
import type { AccessTokenVerifier, OwnerIdentity } from "./verify-access-token";
import { getRequestId } from "@/shared/observability/request-id";
import { serializeBootstrapLogEvent } from "@/shared/observability/structured-log";

type PrivateRequestDependencies<Result extends object> = Readonly<{
  operation: (owner: OwnerIdentity) => Promise<Result>;
  onAccessDenied: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  onUnhandledFailure: (
    context: Readonly<{ errorCode: string; requestId: string }>,
  ) => void | Promise<void>;
  verifyAccessToken: AccessTokenVerifier;
}>;

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

export class PrivateRequestInputError extends Error {
  readonly status = 400;
  constructor(message = "請求參數無效。") { super(message); this.name = "PrivateRequestInputError"; }
}

function safeErrorResponse(status: number, message: string, requestId: string) {
  return Response.json(
    { message, requestId },
    { status, headers: PRIVATE_RESPONSE_HEADERS },
  );
}

async function observeFailureWithoutChangingResponse(
  requestId: string,
  observer: () => void | Promise<void>,
) {
  try {
    await observer();
  } catch {
    const observerError = new FailureObserverFailedError();
    console.error(serializeBootstrapLogEvent({
      event: "failure_observer_failed",
      level: "error",
      requestId,
      operation: "private_request_boundary",
      errorCode: observerError.code,
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: null,
    }));
  }
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
    if (error instanceof PrivateRequestInputError) return safeErrorResponse(error.status, error.message, requestId);
    if (error instanceof AccessDeniedError) {
      await observeFailureWithoutChangingResponse(requestId, () =>
        dependencies.onAccessDenied({ requestId }),
      );
      return safeErrorResponse(401, error.message, requestId);
    }
    const operationError = new PrivateOperationFailedError();
    await observeFailureWithoutChangingResponse(requestId, () =>
      dependencies.onUnhandledFailure({
        errorCode: operationError.code,
        requestId,
      }),
    );
    return safeErrorResponse(500, operationError.message, requestId);
  }
}

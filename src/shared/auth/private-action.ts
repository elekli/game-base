import { z } from "zod";
import { AccessDeniedError } from "./access-denied-error";
import { FailureObserverFailedError } from "./failure-observer-failed-error";
import { PrivateOperationFailedError } from "./private-operation-failed-error";
import { requireOwner } from "./require-owner";
import type { AccessTokenVerifier, OwnerIdentity } from "./verify-access-token";
import { getRequestId } from "@/shared/observability/request-id";
import { serializeBootstrapLogEvent } from "@/shared/observability/structured-log";
import { SourceIdentityConflictError, SourceOperationError } from "@/modules/games";
import { LibraryConflictError } from "@/modules/library";

type PrivateActionDependencies = Readonly<{
  verifyAccessToken: AccessTokenVerifier;
  onAccessDenied: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  onUnhandledFailure: (context: Readonly<{ errorCode: string; requestId: string }>) => void | Promise<void>;
}>;

type PrivateActionFailureCode = "access_denied" | "invalid_input" | "library_conflict" | "source_operation" | "operation_failed";

export type PrivateActionResult<Success extends object = Record<never, never>> =
  | (Readonly<{ ok: true }> & Success)
  | Readonly<{
    ok: false;
    code: PrivateActionFailureCode;
    message: string;
    requestId: string;
    existingGameId?: string;
    existingIsTrashed?: boolean;
    retryAfterSeconds?: number;
  }>;

type PrivateActionOptions<Input, Success extends object> = PrivateActionDependencies & Readonly<{
  input: unknown;
  inputErrorMessage: string;
  operation: (owner: OwnerIdentity, input: Input) => Promise<Success>;
  schema: z.ZodType<Input>;
}>;

async function observeFailureWithoutChangingResult(
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
      operation: "private_action_boundary",
      errorCode: observerError.code,
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: null,
    }));
  }
}

export async function handlePrivateAction<Input, Success extends object>(
  headers: Headers,
  options: PrivateActionOptions<Input, Success>,
): Promise<PrivateActionResult<Success>> {
  const requestId = getRequestId(headers);
  try {
    const owner = await requireOwner(headers, options.verifyAccessToken);
    const parsed = options.schema.safeParse(options.input);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: options.inputErrorMessage, requestId };
    }
    return { ok: true, ...(await options.operation(owner, parsed.data)) };
  } catch (error) {
    if (error instanceof LibraryConflictError) {
      return { ok: false, code: "library_conflict", message: error.message, requestId };
    }
    if (error instanceof SourceOperationError) {
      return {
        ok: false,
        code: "source_operation",
        message: error.message,
        requestId,
        ...(error instanceof SourceIdentityConflictError ? { existingGameId: error.gameId } : {}),
        ...(error instanceof SourceIdentityConflictError ? { existingIsTrashed: error.trashed } : {}),
        ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    }
    if (error instanceof AccessDeniedError) {
      await observeFailureWithoutChangingResult(requestId, () => options.onAccessDenied({ requestId }));
      return { ok: false, code: "access_denied", message: error.message, requestId };
    }
    const operationError = new PrivateOperationFailedError();
    await observeFailureWithoutChangingResult(requestId, () => options.onUnhandledFailure({
      errorCode: operationError.code,
      requestId,
    }));
    return { ok: false, code: "operation_failed", message: operationError.message, requestId };
  }
}

export type { PrivateActionDependencies };

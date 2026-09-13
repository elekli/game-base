const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PRODUCTION_RELEASE_DIAGNOSTIC_ERROR_CODES = [
  "boundary-origin-denied",
  "boundary-owner-auth-denied",
  "network-or-timeout",
  "release-route-http-failure",
  "release-route-reply-invalid",
  "runner-action-timeout",
  "unknown-error",
] as const;

export type ProductionReleaseDiagnosticErrorCode =
  (typeof PRODUCTION_RELEASE_DIAGNOSTIC_ERROR_CODES)[number];

export type ProductionReleaseFailureDiagnostic = Readonly<{
  actionKind: "run-production-smoke";
  failureCode: "smoke-execution-crash" | "smoke-execution-timeout";
  errorCode: ProductionReleaseDiagnosticErrorCode;
  httpStatus?: number;
  requestId?: string;
}>;

type DiagnosticOptions = Readonly<{ httpStatus?: number; requestId?: string }>;

export class ProductionReleaseDiagnosticError extends Error {
  readonly errorCode: ProductionReleaseDiagnosticErrorCode;
  readonly httpStatus?: number;
  readonly requestId?: string;

  constructor(
    safeDetail: string,
    errorCode: ProductionReleaseDiagnosticErrorCode,
    options: DiagnosticOptions = {},
  ) {
    super(safeDetail);
    this.errorCode = errorCode;
    this.httpStatus = validHttpStatus(options.httpStatus)
      ? options.httpStatus
      : undefined;
    this.requestId = validRequestId(options.requestId)
      ? options.requestId
      : undefined;
  }
}

export function validHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function smokeInterruptionDiagnostic(
  error: unknown,
  failureCode: ProductionReleaseFailureDiagnostic["failureCode"],
): ProductionReleaseFailureDiagnostic {
  if (failureCode === "smoke-execution-timeout") {
    return {
      actionKind: "run-production-smoke",
      failureCode,
      errorCode: "runner-action-timeout",
    };
  }
  if (error instanceof ProductionReleaseDiagnosticError) {
    return {
      actionKind: "run-production-smoke",
      failureCode,
      errorCode: PRODUCTION_RELEASE_DIAGNOSTIC_ERROR_CODES.includes(error.errorCode)
        ? error.errorCode : "unknown-error",
      ...(validHttpStatus(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
      ...(validRequestId(error.requestId) ? { requestId: error.requestId } : {}),
    };
  }
  return {
    actionKind: "run-production-smoke",
    failureCode,
    errorCode: "unknown-error",
  };
}

export function isProductionReleaseFailureDiagnostic(
  value: unknown,
): value is ProductionReleaseFailureDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  return (
    diagnostic.actionKind === "run-production-smoke" &&
    (diagnostic.failureCode === "smoke-execution-crash" ||
      diagnostic.failureCode === "smoke-execution-timeout") &&
    typeof diagnostic.errorCode === "string" &&
    PRODUCTION_RELEASE_DIAGNOSTIC_ERROR_CODES.includes(
      diagnostic.errorCode as ProductionReleaseDiagnosticErrorCode,
    ) &&
    (diagnostic.httpStatus === undefined || validHttpStatus(diagnostic.httpStatus)) &&
    (diagnostic.requestId === undefined || validRequestId(diagnostic.requestId))
  );
}

// Runtime values may contain extra keys even after structural validation.
export function projectProductionReleaseFailureDiagnostic(value: ProductionReleaseFailureDiagnostic): ProductionReleaseFailureDiagnostic {
  return {
    actionKind: value.actionKind,
    failureCode: value.failureCode,
    errorCode: value.errorCode,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

import { z } from "zod";
import type { ReleaseSmokeAccessTokenVerifier } from "@/shared/auth/verify-release-smoke-access-token";
import { getRequestId } from "@/shared/observability/request-id";

const MAX_REQUEST_BODY_BYTES = 1024;
const REQUEST_BODY_DEADLINE_MS = 1_000;
const OPERATION_DEADLINE_MS = 35_000;
const RESPONSE_HEADERS = { "cache-control": "private, no-store" } as const;

const requestSchema = z
  .object({
    executionSha: z.string().regex(/^[0-9a-f]{40}$/),
    generation: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    actionSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    operation: z.enum([
      "inspect-baseline",
      "run-fixed-read-checks",
      "write-row",
      "write-object",
      "verify-round-trip",
      "cleanup-exact",
      "inspect-cleanup",
    ]),
  })
  .strict();

type ProductionBinding = Readonly<{
  projectRef: string;
  releaseSmokeCommonNameSha256: string | null;
  releaseSmokeMaxTokenLifetimeSeconds: number | null;
}>;

export type ReleaseSmokeConfig = Readonly<{
  environment: "development" | "preview" | "production";
  databaseUrl: string;
  cloudflare: Readonly<{
    audience: string;
    issuer: string;
    jwksUrl: string;
  }>;
  releaseSmoke: Readonly<{
    commonNameSha256: string | null;
    maxTokenLifetimeSeconds: number | null;
    ready: boolean;
  }>;
  supabase: Readonly<{ projectRef: string; secretKey: string; url: string }>;
}>;

export type ReleaseSmokeOperationInput = z.infer<typeof requestSchema>;
export type ReleaseSmokeOperationResult = Readonly<Record<string, unknown>> &
  Readonly<{ kind: string }>;
type ReleaseSmokeCanaryDependencies = Readonly<{
  execute: (input: ReleaseSmokeOperationInput, signal: AbortSignal) => Promise<ReleaseSmokeOperationResult>;
  close: () => Promise<void> | void;
}>;

type ReleaseSmokeRouteDependencies = Readonly<{
  createCanaryDependencies: (config: ReleaseSmokeConfig) => ReleaseSmokeCanaryDependencies;
  getRuntimeConfig: () => ReleaseSmokeConfig;
  getVercelEnvironment: () => string | undefined;
  getVerifier: (config: Readonly<{
    audience: string;
    issuer: string;
    jwksUrl: string;
    commonNameSha256: string;
    maxLifetimeSeconds: number;
  }>) => ReleaseSmokeAccessTokenVerifier;
  observeFailure: (context: Readonly<{
    errorCode: string;
    requestId: string;
  }>) => void | Promise<void>;
  productionBinding: ProductionBinding;
}>;

class ReleaseSmokeBodyTooLargeError extends Error {
  constructor() {
    super("release-smoke request body exceeds 1 KiB");
    this.name = "ReleaseSmokeBodyTooLargeError";
  }
}

class ReleaseSmokeBodyTimeoutError extends Error {
  constructor() {
    super("release-smoke request body deadline exceeded");
    this.name = "ReleaseSmokeBodyTimeoutError";
  }
}

async function readBoundedBody(request: Request) {
  if (!request.body) throw new SyntaxError("missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new ReleaseSmokeBodyTimeoutError()),
      REQUEST_BODY_DEADLINE_MS,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BODY_BYTES) {
        throw new ReleaseSmokeBodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function response(status: number, message: string, errorCode: string, requestId: string) {
  return Response.json(
    { errorCode, message, requestId },
    { status, headers: RESPONSE_HEADERS },
  );
}

function success(event: ReleaseSmokeOperationResult, requestId: string) {
  return Response.json(
    { event, requestId },
    { status: 200, headers: RESPONSE_HEADERS },
  );
}

function safeOperationFailure(error: unknown): ReleaseSmokeOperationResult | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value.safeDetail !== "string" || value.safeDetail.length < 1 || value.safeDetail.length > 256) {
    return undefined;
  }
  if (value.name === "ProductionSmokeOperationUncertainError") {
    return { kind: "operation-uncertain", safeDetail: value.safeDetail };
  }
  if (value.name === "ProductionSmokeOperationError") {
    return { kind: "operation-failed", safeDetail: value.safeDetail };
  }
  return undefined;
}

async function safelyObserve(
  dependencies: ReleaseSmokeRouteDependencies,
  errorCode: string,
  requestId: string,
) {
  try {
    await dependencies.observeFailure({ errorCode, requestId });
  } catch {
    console.error(JSON.stringify({
      event: "failure_observer_failed",
      errorCode: "release_smoke_failure_observer_failed",
      requestId,
    }));
  }
}

function hasPinnedProductionBinding(
  config: ReleaseSmokeConfig,
  binding: ProductionBinding,
): config is ReleaseSmokeConfig & {
  releaseSmoke: {
    commonNameSha256: string;
    maxTokenLifetimeSeconds: number;
    ready: true;
  };
} {
  return (
    config.environment === "production" &&
    config.supabase.projectRef === binding.projectRef &&
    binding.releaseSmokeCommonNameSha256 !== null &&
    /^[0-9a-f]{64}$/.test(binding.releaseSmokeCommonNameSha256) &&
    binding.releaseSmokeMaxTokenLifetimeSeconds !== null &&
    Number.isSafeInteger(binding.releaseSmokeMaxTokenLifetimeSeconds) &&
    binding.releaseSmokeMaxTokenLifetimeSeconds > 0 &&
    config.releaseSmoke.ready === true &&
    config.releaseSmoke.commonNameSha256 ===
      binding.releaseSmokeCommonNameSha256 &&
    config.releaseSmoke.maxTokenLifetimeSeconds ===
      binding.releaseSmokeMaxTokenLifetimeSeconds
  );
}

export function createReleaseSmokeRouteHandler(
  dependencies: ReleaseSmokeRouteDependencies,
) {
  return async function handleReleaseSmokeRequest(request: Request) {
    const requestId = getRequestId(request.headers);

    if (dependencies.getVercelEnvironment() !== "production") {
      return response(
        503,
        "Release smoke 尚未就緒。",
        "release_smoke_not_production",
        requestId,
      );
    }

    let config: ReleaseSmokeConfig;
    try {
      config = dependencies.getRuntimeConfig();
    } catch {
      await safelyObserve(dependencies, "release_smoke_config_invalid", requestId);
      return response(
        503,
        "Release smoke 尚未就緒。",
        "release_smoke_config_invalid",
        requestId,
      );
    }

    if (!hasPinnedProductionBinding(config, dependencies.productionBinding)) {
      await safelyObserve(dependencies, "release_smoke_not_ready", requestId);
      return response(
        503,
        "Release smoke 尚未就緒。",
        "release_smoke_not_ready",
        requestId,
      );
    }

    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) {
      await safelyObserve(dependencies, "release_smoke_access_denied", requestId);
      return response(
        401,
        "無法驗證存取權限。",
        "release_smoke_access_denied",
        requestId,
      );
    }

    try {
      const verifyAccessToken = dependencies.getVerifier({
        ...config.cloudflare,
        commonNameSha256: config.releaseSmoke.commonNameSha256,
        maxLifetimeSeconds: config.releaseSmoke.maxTokenLifetimeSeconds,
      });
      await verifyAccessToken(assertion);
    } catch {
      await safelyObserve(dependencies, "release_smoke_access_denied", requestId);
      return response(
        401,
        "無法驗證存取權限。",
        "release_smoke_access_denied",
        requestId,
      );
    }

    let operation: ReleaseSmokeOperationInput;
    try {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        throw new SyntaxError("request body must be JSON");
      }
      const parsed = requestSchema.safeParse(JSON.parse(await readBoundedBody(request)));
      if (!parsed.success) throw new SyntaxError("invalid release-smoke request");
      operation = parsed.data;
    } catch (error) {
      if (error instanceof ReleaseSmokeBodyTimeoutError) {
        return response(
          408,
          "請求內容讀取逾時。",
          "release_smoke_request_timeout",
          requestId,
        );
      }
      const errorCode =
        error instanceof ReleaseSmokeBodyTooLargeError
          ? "release_smoke_request_too_large"
          : "release_smoke_request_invalid";
      return response(400, "請求參數無效。", errorCode, requestId);
    }

    let canary: ReleaseSmokeCanaryDependencies;
    try {
      canary = dependencies.createCanaryDependencies(config);
    } catch {
      await safelyObserve(dependencies, "release_smoke_dependency_init_failed", requestId);
      return response(503, "Release smoke 操作失敗。", "release_smoke_operation_failed", requestId);
    }

    let event: ReleaseSmokeOperationResult | undefined;
    let operationError: unknown;
    const operationController = new AbortController();
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      event = await Promise.race([
        canary.execute(operation, operationController.signal),
        new Promise<never>((_resolve, reject) => {
          operationTimer = setTimeout(() => {
            operationController.abort();
            reject({
              name: "ProductionSmokeOperationUncertainError",
              safeDetail: "route operation deadline exceeded",
            });
          }, OPERATION_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      operationError = error;
    } finally {
      if (operationTimer !== undefined) clearTimeout(operationTimer);
    }
    let closeFailed = false;
    try {
      await canary.close();
    } catch {
      closeFailed = true;
      await safelyObserve(dependencies, "release_smoke_dependency_close_failed", requestId);
    }
    const namedFailure = safeOperationFailure(operationError);
    if (!closeFailed && namedFailure) {
      await safelyObserve(dependencies, `release_smoke_${namedFailure.kind.replaceAll("-", "_")}`, requestId);
      return success(namedFailure, requestId);
    }
    if (operationError !== undefined || closeFailed || event === undefined) {
      await safelyObserve(dependencies, "release_smoke_operation_failed", requestId);
      return response(503, "Release smoke 操作失敗。", "release_smoke_operation_failed", requestId);
    }
    return success(event, requestId);
  };
}

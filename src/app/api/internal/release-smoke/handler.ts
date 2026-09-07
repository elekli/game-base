import { z } from "zod";
import type { ReleaseSmokeAccessTokenVerifier } from "@/shared/auth/verify-release-smoke-access-token";
import { getRequestId } from "@/shared/observability/request-id";

const MAX_REQUEST_BODY_BYTES = 1024;
const REQUEST_BODY_DEADLINE_MS = 1_000;
const RESPONSE_HEADERS = { "cache-control": "private, no-store" } as const;

const requestSchema = z
  .object({
    executionSha: z.string().regex(/^[0-9a-f]{40}$/),
    generation: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
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

type ReleaseSmokeConfig = Readonly<{
  environment: "development" | "preview" | "production";
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
  supabase: Readonly<{ projectRef: string }>;
}>;

type ReleaseSmokeRouteDependencies = Readonly<{
  createCanaryDependencies: () => unknown;
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

    try {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        throw new SyntaxError("request body must be JSON");
      }
      const parsed = requestSchema.safeParse(JSON.parse(await readBoundedBody(request)));
      if (!parsed.success) throw new SyntaxError("invalid release-smoke request");
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

    await safelyObserve(
      dependencies,
      "release_smoke_canary_not_implemented",
      requestId,
    );
    return response(
      503,
      "Release smoke canary 尚未實作。",
      "release_smoke_canary_not_implemented",
      requestId,
    );
  };
}

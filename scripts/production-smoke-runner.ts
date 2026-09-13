import {
  consumeProductionSmokeCanaryTerminal,
  createProductionSmokeCanary,
  transitionProductionSmokeCanary,
  type ProductionSmokeCanaryAction,
  type ProductionSmokeCanaryEventPayload,
  type ProductionSmokeCanaryTerminal,
  PRODUCTION_SMOKE_PERSISTED_PHASES,
  PRODUCTION_SMOKE_OBJECT_PATH,
  PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH,
  type ProductionSmokePersistedPhase,
} from "./production-smoke-canary";
import {
  ProductionReleaseDiagnosticError,
  validRequestId,
  type ProductionReleaseDiagnosticErrorCode,
} from "./production-release-failure-diagnostics";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ACTIONS = 16;
const MAX_TRANSPORT_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 40_000;
const RUN_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BODY_BYTES = 4_096;

export class ProductionSmokePrerequisiteError extends Error {
  constructor() {
    super("Production smoke repository prerequisites are incomplete.");
    this.name = "ProductionSmokePrerequisiteError";
  }
}

export class ProductionSmokeTransportError extends ProductionReleaseDiagnosticError {
  constructor(
    readonly safeDetail: string,
    errorCode: ProductionReleaseDiagnosticErrorCode = "unknown-error",
    options: Readonly<{ httpStatus?: number; requestId?: string }> = {},
  ) {
    super(`ProductionSmokeTransportError: ${safeDetail}`, errorCode, options);
    this.name = "ProductionSmokeTransportError";
  }
}

export type ProductionSmokeRunnerConfig = Readonly<{
  customDomain: string;
  deploymentOrigin: string;
  supabaseUrl: string;
  publishableKey: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
  ownerAccessJwt: string;
}>;

type RouteResult = Readonly<{
  event: Readonly<Record<string, unknown>>;
  requestId: string;
}>;

export type ProductionSmokeRunnerDependencies = Readonly<{
  callRoute(action: ProductionSmokeCanaryAction, executionSha: string, signal: AbortSignal): Promise<RouteResult>;
  runBoundaryChecks(signal: AbortSignal): Promise<Readonly<{
    "custom-domain-owner-access": "passed";
    "direct-origin-denied": "passed";
  }>>;
  checkPrivateStorageDenial(signal: AbortSignal): Promise<"passed">;
  now(): number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationFor(action: ProductionSmokeCanaryAction) {
  switch (action.kind) {
    case "inspect-canary-counts":
      return action.purpose === "baseline" ? "inspect-baseline" : "inspect-cleanup";
    case "run-fixed-read-checks": return "run-fixed-read-checks";
    case "write-canary-row": return "write-row";
    case "write-canary-object": return "write-object";
    case "verify-round-trip": return "verify-round-trip";
    case "verify-private-storage-denial":
      throw new ProductionSmokeTransportError("private Storage denial is an external-only action");
    case "cleanup-exact-canary": return "cleanup-exact";
    case "stop": throw new ProductionSmokeTransportError("runner reached a non-terminal stop action");
  }
}

function optionalString(event: Readonly<Record<string, unknown>>, key: string) {
  const value = event[key];
  if (value === undefined || typeof value === "string") return value;
  throw new ProductionSmokeTransportError("release-smoke route evidence is invalid");
}

function optionalSafeInteger(event: Readonly<Record<string, unknown>>, key: string) {
  const value = event[key];
  if (value === undefined || Number.isSafeInteger(value)) return value as number | undefined;
  throw new ProductionSmokeTransportError("release-smoke route evidence is invalid");
}

function observedCounts(event: Readonly<Record<string, unknown>>) {
  if (
    !Number.isSafeInteger(event.rowCount) || (event.rowCount as number) < 0 ||
    !Number.isSafeInteger(event.objectCount) || (event.objectCount as number) < 0
  ) throw new ProductionSmokeTransportError("release-smoke count evidence is invalid");
  const rowPhase = optionalString(event, "rowPhase");
  if (
    rowPhase !== undefined &&
    !PRODUCTION_SMOKE_PERSISTED_PHASES.includes(rowPhase as ProductionSmokePersistedPhase)
  ) throw new ProductionSmokeTransportError("release-smoke row phase is invalid");
  return {
    rowCount: event.rowCount as number,
    objectCount: event.objectCount as number,
    rowIdentity: optionalString(event, "rowIdentity"),
    objectIdentity: optionalString(event, "objectIdentity"),
    rowGeneration: optionalString(event, "rowGeneration"),
    objectGeneration: optionalString(event, "objectGeneration"),
    rowActionSequence: optionalSafeInteger(event, "rowActionSequence"),
    rowPhase: rowPhase as ProductionSmokePersistedPhase | undefined,
    rowPayloadSha256: optionalString(event, "rowPayloadSha256"),
    objectPayloadSha256: optionalString(event, "objectPayloadSha256"),
  };
}

function routeEvent(
  action: ProductionSmokeCanaryAction,
  result: RouteResult,
  externalChecks?: Awaited<ReturnType<ProductionSmokeRunnerDependencies["runBoundaryChecks"]>>,
): ProductionSmokeCanaryEventPayload {
  if (!REQUEST_ID.test(result.requestId) || !isRecord(result.event) || typeof result.event.kind !== "string") {
    throw new ProductionSmokeTransportError("release-smoke route response is invalid");
  }
  const event = result.event;
  if (action.kind === "run-fixed-read-checks") {
    if (
      event.kind !== "fixed-read-checks-observed" ||
      !isRecord(event.checks) ||
      event.checks["authenticated-library-read"] !== "passed" ||
      event.checks["runtime-database-read"] !== "passed" ||
      !externalChecks
    ) throw new ProductionSmokeTransportError("internal read-check evidence is incomplete");
    return {
      kind: "fixed-read-checks-observed",
      checks: { ...externalChecks, "authenticated-library-read": "passed", "runtime-database-read": "passed" },
      requestIds: [result.requestId],
    };
  }
  if (event.kind === "operation-failed" || event.kind === "operation-uncertain") {
    if (typeof event.safeDetail !== "string" || event.safeDetail.length < 1 || event.safeDetail.length > 256) {
      throw new ProductionSmokeTransportError("operation failure evidence is invalid");
    }
    return { kind: event.kind, safeDetail: event.safeDetail };
  }
  if (action.kind === "inspect-canary-counts") {
    if (event.kind !== "counts-observed" || event.purpose !== action.purpose) {
      throw new ProductionSmokeTransportError("count evidence purpose is invalid");
    }
    return { kind: "counts-observed", purpose: action.purpose, ...observedCounts(event) };
  }
  if (action.kind === "write-canary-row" && event.kind === "row-written") return { kind: "row-written" };
  if (action.kind === "write-canary-object" && event.kind === "object-written") return { kind: "object-written" };
  if (action.kind === "cleanup-exact-canary" && event.kind === "cleanup-finished") return { kind: "cleanup-finished" };
  if (action.kind === "verify-round-trip" && event.kind === "round-trip-observed") {
    return { kind: "round-trip-observed", ...observedCounts(event), requestIds: [result.requestId] };
  }
  throw new ProductionSmokeTransportError("route event does not match the active action");
}

export async function runProductionSmokeCanary(
  input: Readonly<{ executionSha: string; generation: string }>,
  dependencies: ProductionSmokeRunnerDependencies,
): Promise<ProductionSmokeCanaryTerminal> {
  let canary = createProductionSmokeCanary(input);
  const deadlineAt = dependencies.now() + RUN_TIMEOUT_MS;
  const controller = new AbortController();
  const runTimer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const withinDeadline = async <T>(operation: () => Promise<T>) => {
    const remaining = deadlineAt - dependencies.now();
    if (remaining <= 0) throw new ProductionSmokeTransportError("production smoke total deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProductionSmokeTransportError("production smoke total deadline exceeded"));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const retryTransport = async <T>(operation: () => Promise<T>) => {
    for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
      try {
        return await withinDeadline(operation);
      } catch (error) {
        if (
          !(error instanceof ProductionSmokeTransportError) ||
          controller.signal.aborted ||
          attempt === MAX_TRANSPORT_ATTEMPTS
        ) throw error;
      }
    }
    throw new ProductionSmokeTransportError("production smoke transport retry bound exceeded");
  };
  try {
    for (let step = 0; step < MAX_ACTIONS; step += 1) {
      if (dependencies.now() >= deadlineAt || controller.signal.aborted) {
        throw new ProductionSmokeTransportError("production smoke total deadline exceeded");
      }
      const terminal = consumeProductionSmokeCanaryTerminal(canary);
      if (terminal) return terminal;
      const action = canary.next;
      if (action.kind === "verify-private-storage-denial") {
        try {
          const status = await retryTransport(() => dependencies.checkPrivateStorageDenial(controller.signal));
          canary = transitionProductionSmokeCanary(canary, {
            kind: "private-storage-denial-observed",
            status,
            generation: canary.generation,
            actionSequence: action.actionSequence,
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          canary = transitionProductionSmokeCanary(canary, {
            kind: "operation-failed",
            safeDetail: error instanceof ProductionSmokeTransportError
              ? error.safeDetail
              : "private Storage denial check failed",
            generation: canary.generation,
            actionSequence: action.actionSequence,
          });
        }
        continue;
      }
      const externalChecks = action.kind === "run-fixed-read-checks"
        ? await retryTransport(() => dependencies.runBoundaryChecks(controller.signal))
        : undefined;
      const result = await retryTransport(
        () => dependencies.callRoute(action, input.executionSha, controller.signal),
      );
      canary = transitionProductionSmokeCanary(canary, {
        ...routeEvent(action, result, externalChecks),
        generation: canary.generation,
        actionSequence: action.actionSequence,
      });
    }
    throw new ProductionSmokeTransportError("production smoke action bound exceeded");
  } finally {
    clearTimeout(runTimer);
  }
}

function assertUrl(value: string, expectedProtocol = "https:") {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductionSmokePrerequisiteError();
  }
  if (
    url.protocol !== expectedProtocol || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/" || !url.hostname
  ) throw new ProductionSmokePrerequisiteError();
  return url;
}

function isVercelLoginRedirect(status: number, location: string | null, base: string) {
  if (![301, 302, 303, 307, 308].includes(status) || location === null) return false;
  try {
    const url = new URL(location, base);
    return url.protocol === "https:" &&
      (url.hostname === "vercel.com" || url.hostname.endsWith(".vercel.com"));
  } catch {
    return false;
  }
}

async function boundedFetch(fetchImpl: typeof fetch, input: string, init: RequestInit, parentSignal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, cache: "no-store", redirect: "manual", signal: controller.signal });
  } catch {
    throw new ProductionSmokeTransportError("production smoke request failed", "network-or-timeout");
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!response.body) throw new ProductionSmokeTransportError("release-smoke route response is empty", "release-route-reply-invalid");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProductionSmokeTransportError("release-smoke route response deadline exceeded", "network-or-timeout")),
      timeoutMs,
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BODY_BYTES) {
        throw new ProductionSmokeTransportError("release-smoke route response is too large", "release-route-reply-invalid");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ProductionSmokeTransportError) throw error;
    throw new ProductionSmokeTransportError("release-smoke route response could not be read", "release-route-reply-invalid");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ProductionSmokeTransportError("release-smoke route response is not valid JSON", "release-route-reply-invalid");
  }
}

function createProductionSmokeRunnerDependencies(
  config: ProductionSmokeRunnerConfig,
  fetchImpl: typeof fetch = fetch,
): ProductionSmokeRunnerDependencies {
  if (
    !config ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(config.customDomain) ||
    !config.cfAccessClientId ||
    !config.cfAccessClientSecret ||
    !config.ownerAccessJwt ||
    !config.publishableKey.startsWith("sb_publishable_")
  ) throw new ProductionSmokePrerequisiteError();
  const customOrigin = assertUrl(`https://${config.customDomain}`).origin;
  const deploymentOrigin = assertUrl(config.deploymentOrigin).origin;
  const supabaseOrigin = assertUrl(config.supabaseUrl).origin;
  if (customOrigin === deploymentOrigin || customOrigin === supabaseOrigin || deploymentOrigin === supabaseOrigin) {
    throw new ProductionSmokePrerequisiteError();
  }

  const dependencies: ProductionSmokeRunnerDependencies = {
    now: Date.now,
    async callRoute(action, executionSha, signal) {
      if (action.kind === "stop" || action.kind === "verify-private-storage-denial") {
        throw new ProductionSmokeTransportError("runner reached a non-terminal stop action");
      }
      const response = await boundedFetch(fetchImpl, `${customOrigin}/api/internal/release-smoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": config.cfAccessClientId,
          "CF-Access-Client-Secret": config.cfAccessClientSecret,
        },
        body: JSON.stringify({
          executionSha,
          generation: action.generation,
          actionSequence: action.actionSequence,
          operation: operationFor(action),
        }),
      }, signal);
      if (response.status !== 200) {
        let requestId: string | undefined;
        try {
          const rejection = await readBoundedJson(response, signal, 1_000);
          if (isRecord(rejection) && validRequestId(rejection.requestId)) {
            requestId = rejection.requestId;
          }
        } catch {
          // An unreadable rejection must not replace the original HTTP failure.
          requestId = undefined;
        }
        throw new ProductionSmokeTransportError(
          "release-smoke route rejected the request",
          "release-route-http-failure",
          { httpStatus: response.status, requestId },
        );
      }
      const value = await readBoundedJson(response, signal);
      if (!isRecord(value) || !isRecord(value.event) || typeof value.requestId !== "string") {
        throw new ProductionSmokeTransportError("release-smoke route envelope is invalid", "release-route-reply-invalid");
      }
      return { event: value.event, requestId: value.requestId };
    },
    async runBoundaryChecks(signal) {
      const owner = await boundedFetch(fetchImpl, `${customOrigin}/api/private/ping`, {
        method: "GET",
        headers: { cookie: `CF_Authorization=${config.ownerAccessJwt}` },
      }, signal);
      if (owner.status !== 200) throw new ProductionSmokeTransportError(
        "custom-domain owner access failed",
        "boundary-owner-auth-denied",
        { httpStatus: owner.status },
      );
      const origin = await boundedFetch(fetchImpl, `${deploymentOrigin}/security-error`, { method: "GET" }, signal);
      const redirectLocation = origin.headers.get("location");
      const vercelLoginRedirect = isVercelLoginRedirect(
        origin.status,
        redirectLocation,
        deploymentOrigin,
      );
      if (!vercelLoginRedirect) {
        throw new ProductionSmokeTransportError(
          "direct origin was not denied",
          "boundary-origin-denied",
          { httpStatus: origin.status },
        );
      }
      return {
        "custom-domain-owner-access": "passed",
        "direct-origin-denied": "passed",
      };
    },
    async checkPrivateStorageDenial(signal) {
      for (const path of [
        PRODUCTION_SMOKE_OBJECT_PATH,
        PRODUCTION_SMOKE_THUMBNAIL_OBJECT_PATH,
      ]) {
        const storage = await boundedFetch(
          fetchImpl,
          `${supabaseOrigin}/storage/v1/object/public/game-media/${path}`,
          { method: "GET", headers: { apikey: config.publishableKey } },
          signal,
        );
        if (![400, 401, 403].includes(storage.status)) {
          throw new ProductionSmokeTransportError("private Storage public path was not denied");
        }
      }
      return "passed";
    },
  };
  return dependencies;
}

export function createProductionSmokeActionRunner(
  config: ProductionSmokeRunnerConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const dependencies = createProductionSmokeRunnerDependencies(
    config,
    fetchImpl,
  );
  const retryTransport = async <T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ) => {
    for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof ProductionSmokeTransportError) ||
          signal.aborted ||
          attempt === MAX_TRANSPORT_ATTEMPTS
        ) throw error;
      }
    }
    throw new ProductionSmokeTransportError(
      "production smoke transport retry bound exceeded",
    );
  };
  return async (
    action: ProductionSmokeCanaryAction,
    executionSha: string,
    signal: AbortSignal,
  ): Promise<ProductionSmokeCanaryEventPayload> => {
    if (action.kind === "verify-private-storage-denial") {
      try {
        return {
          kind: "private-storage-denial-observed",
          status: await retryTransport(
            signal,
            () => dependencies.checkPrivateStorageDenial(signal),
          ),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          kind: "operation-failed",
          safeDetail: error instanceof ProductionSmokeTransportError
            ? error.safeDetail
            : "private Storage denial check failed",
        };
      }
    }
    const externalChecks =
      action.kind === "run-fixed-read-checks"
        ? await retryTransport(
            signal,
            () => dependencies.runBoundaryChecks(signal),
          )
        : undefined;
    return routeEvent(
      action,
      await retryTransport(
        signal,
        () => dependencies.callRoute(action, executionSha, signal),
      ),
      externalChecks,
    );
  };
}

export function createProductionSmokeRunner(
  config: ProductionSmokeRunnerConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const dependencies = createProductionSmokeRunnerDependencies(
    config,
    fetchImpl,
  );
  return (input: Readonly<{ executionSha: string; generation: string }>) =>
    runProductionSmokeCanary(input, dependencies);
}

import { describe, expect, it, vi } from "vitest";
import { createReleaseSmokeRouteHandler } from "@/app/api/internal/release-smoke/handler";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import { deploymentBindings } from "@/shared/config/deployment-bindings";

const validBody = JSON.stringify({
  executionSha: "0123456789abcdef0123456789abcdef01234567",
  generation: "1f45c8cc-6b61-4c4b-8f26-dc8c70bbd539",
  actionSequence: 1,
  operation: "inspect-baseline",
});

function readyConfig() {
  return {
    environment: "production" as const,
    databaseUrl: "postgres://app_runtime.production:secret@example.test:6543/postgres",
    cloudflare: {
      audience: "production-audience",
      issuer: "https://puizeru.cloudflareaccess.com",
      jwksUrl: "https://puizeru.cloudflareaccess.com/cdn-cgi/access/certs",
    },
    releaseSmoke: {
      commonNameSha256: "a".repeat(64),
      maxTokenLifetimeSeconds: 300,
      ready: true,
    },
    supabase: {
      projectRef: deploymentBindings.production.projectRef,
      secretKey: "sb_secret_test",
      url: "https://example.supabase.co",
    },
  };
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const verifyAccessToken = vi.fn(async () => ({ kind: "release-smoke" as const }));
  const getVerifier = vi.fn(() => verifyAccessToken);
  const execute = vi.fn(async (...args: [unknown, AbortSignal]) => {
    void args;
    return {
      kind: "counts-observed" as const,
      purpose: "baseline" as const,
      rowCount: 0,
      objectCount: 0,
    };
  });
  const close = vi.fn(async () => undefined);
  const createCanaryDependencies = vi.fn(() => ({ execute, close }));
  const observeFailure = vi.fn();
  const dependencies = {
    createCanaryDependencies,
    getRuntimeConfig: vi.fn(() => readyConfig()),
    getVercelEnvironment: vi.fn(() => "production"),
    getVerifier,
    observeFailure,
    productionBinding: {
      ...deploymentBindings.production,
      releaseSmokeCommonNameSha256: "a".repeat(64),
      releaseSmokeMaxTokenLifetimeSeconds: 300,
    },
    ...overrides,
  };
  return {
    close,
    createCanaryDependencies,
    dependencies,
    execute,
    getVerifier,
    observeFailure,
    verifyAccessToken,
    handler: createReleaseSmokeRouteHandler(dependencies),
  };
}

function request(body = validBody, headers: Record<string, string> = {}) {
  return new Request("https://gamebase.example.test/api/internal/release-smoke", {
    body,
    headers: {
      "content-type": "application/json",
      "Cf-Access-Jwt-Assertion": "service-assertion-secret",
      ...headers,
    },
    method: "POST",
  });
}

describe("POST /api/internal/release-smoke", () => {
  it("stops before reading the body or creating dependencies outside Production", async () => {
    const harness = makeHarness({
      getVercelEnvironment: vi.fn(() => "preview"),
      getRuntimeConfig: vi.fn(),
    });
    const incomingRequest = request();
    const bodyRead = vi.spyOn(incomingRequest, "body", "get");

    const response = await harness.handler(incomingRequest);

    expect(response.status).toBe(503);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(harness.dependencies.getRuntimeConfig).not.toHaveBeenCalled();
    expect(harness.getVerifier).not.toHaveBeenCalled();
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it.each([
    ["repository Production binding mismatch", { supabase: { projectRef: "wrong-ref" } }],
    ["missing release-smoke pins", {
      releaseSmoke: { commonNameSha256: null, maxTokenLifetimeSeconds: null, ready: false },
    }],
  ])("fails closed for %s before authentication", async (_name, configOverride) => {
    const config = { ...readyConfig(), ...configOverride };
    const harness = makeHarness({ getRuntimeConfig: vi.fn(() => config) });
    const response = await harness.handler(request());

    expect(response.status).toBe(503);
    expect(harness.getVerifier).not.toHaveBeenCalled();
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it("returns 401 and does not read the body when the assertion is absent", async () => {
    const harness = makeHarness();
    const incomingRequest = request(validBody, {
        "Cf-Access-Jwt-Assertion": "",
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      });
    const bodyRead = vi.spyOn(incomingRequest, "body", "get");
    const response = await harness.handler(incomingRequest);

    expect(response.status).toBe(401);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(harness.verifyAccessToken).not.toHaveBeenCalled();
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it("returns 401 without exposing a rejected assertion or request body", async () => {
    const verifyAccessToken = vi.fn(async () => {
      throw new AccessDeniedError();
    });
    const harness = makeHarness({ getVerifier: vi.fn(() => verifyAccessToken) });
    const response = await harness.handler(request());
    const responseBody = await response.text();

    expect(response.status).toBe(401);
    expect(responseBody).not.toContain("service-assertion-secret");
    expect(responseBody).not.toContain("executionSha");
    expect(harness.observeFailure).toHaveBeenCalledWith({
      errorCode: "release_smoke_access_denied",
      requestId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
    expect(JSON.stringify(harness.observeFailure.mock.calls)).not.toContain(
      "service-assertion-secret",
    );
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it("rejects request bodies larger than 1 KiB without creating canary dependencies", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request("x".repeat(1025)));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errorCode: "release_smoke_request_too_large",
    });
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it("times out one never-settling body deadline without waiting for cancellation", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({
        cancel,
        pull: () => new Promise<void>(() => undefined),
      });
      const incomingRequest = new Request(
        "https://gamebase.example.test/api/internal/release-smoke",
        {
          body,
          duplex: "half",
          headers: {
            "content-type": "application/json",
            "Cf-Access-Jwt-Assertion": "service-assertion-secret",
          },
          method: "POST",
        } as RequestInit,
      );

      const responsePromise = harness.handler(incomingRequest);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({
        errorCode: "release_smoke_request_timeout",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["additional fields", { ...JSON.parse(validBody), objectPath: "caller/path" }],
    ["caller-selected owner", { ...JSON.parse(validBody), owner: "other-owner" }],
    ["uppercase SHA", { ...JSON.parse(validBody), executionSha: "A".repeat(40) }],
    ["non-v4 generation", { ...JSON.parse(validBody), generation: "00000000-0000-1000-8000-000000000000" }],
    ["negative action sequence", { ...JSON.parse(validBody), actionSequence: -1 }],
    ["fractional action sequence", { ...JSON.parse(validBody), actionSequence: 1.5 }],
    ["unknown operation", { ...JSON.parse(validBody), operation: "delete-anything" }],
  ])("rejects %s", async (_name, body) => {
    const harness = makeHarness();
    const response = await harness.handler(request(JSON.stringify(body)));

    expect(response.status).toBe(400);
    expect(harness.createCanaryDependencies).not.toHaveBeenCalled();
  });

  it("dispatches a valid operation only after authentication and closes dependencies", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      event: {
        kind: "counts-observed",
        purpose: "baseline",
        rowCount: 0,
        objectCount: 0,
      },
      requestId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
    expect(harness.execute).toHaveBeenCalledWith({
      executionSha: "0123456789abcdef0123456789abcdef01234567",
      generation: "1f45c8cc-6b61-4c4b-8f26-dc8c70bbd539",
      actionSequence: 1,
      operation: "inspect-baseline",
    }, expect.any(AbortSignal));
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["ProductionSmokeOperationError", "operation-failed"],
    ["ProductionSmokeOperationUncertainError", "operation-uncertain"],
  ])("returns a bounded state-machine event for %s", async (name, kind) => {
    const harness = makeHarness();
    harness.execute.mockRejectedValueOnce({ name, safeDetail: "bounded failure" });

    const response = await harness.handler(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      event: { kind, safeDetail: "bounded failure" },
      requestId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("returns a generic 503 for an unknown operation error without leaking its message", async () => {
    const harness = makeHarness();
    harness.execute.mockRejectedValueOnce(new Error("database password leaked here"));

    const response = await harness.handler(request());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain("database password leaked here");
    expect(body).not.toContain("password");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("returns a generic 503 when dependency close fails after a successful operation", async () => {
    const harness = makeHarness();
    harness.close.mockRejectedValueOnce(new Error("close failed"));

    const response = await harness.handler(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: "release_smoke_operation_failed" });
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.observeFailure).toHaveBeenCalledWith({
      errorCode: "release_smoke_dependency_close_failed",
      requestId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
  });

  it("aborts an operation at the route deadline and returns uncertain evidence", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      harness.execute.mockImplementationOnce((...args: [unknown, AbortSignal]) => {
        const signal = args[1];
        return new Promise(() => signal.addEventListener("abort", () => undefined, { once: true }));
      });
      const responsePromise = harness.handler(request());
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(35_000);
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        event: {
          kind: "operation-uncertain",
          safeDetail: "route operation deadline exceeded",
        },
      });
      expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
      expect(harness.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

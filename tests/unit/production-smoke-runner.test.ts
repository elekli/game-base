import { describe, expect, it, vi } from "vitest";

import { calculateProductionSmokePayloadSha256 } from "../../scripts/production-smoke-canary";
import {
  createProductionSmokeActionRunner,
  createProductionSmokeRunner,
  ProductionSmokePrerequisiteError,
  ProductionSmokeTransportError,
  runProductionSmokeCanary,
  type ProductionSmokeRunnerDependencies,
} from "../../scripts/production-smoke-runner";

const SHA = "a".repeat(40);
const GENERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = `release-smoke-v1:${SHA}`;
const PAYLOAD_SHA = calculateProductionSmokePayloadSha256(SHA);

function routeEvent(operation: string) {
  switch (operation) {
    case "inspect-baseline": return { kind: "counts-observed", purpose: "baseline", rowCount: 0, objectCount: 0 };
    case "run-fixed-read-checks": return {
      kind: "fixed-read-checks-observed",
      checks: { "authenticated-library-read": "passed", "runtime-database-read": "passed" },
    };
    case "write-row": return { kind: "row-written" };
    case "write-object": return { kind: "object-written" };
    case "verify-round-trip": return {
      kind: "round-trip-observed",
      rowCount: 1,
      objectCount: 2,
      rowIdentity: IDENTITY,
      objectIdentity: IDENTITY,
      rowGeneration: GENERATION,
      objectGeneration: GENERATION,
      rowPhase: "object_written",
      rowPayloadSha256: PAYLOAD_SHA,
      objectPayloadSha256: PAYLOAD_SHA,
    };
    case "cleanup-exact": return { kind: "cleanup-finished" };
    case "inspect-cleanup": return { kind: "counts-observed", purpose: "cleanup", rowCount: 0, objectCount: 0 };
    default: throw new Error(`unexpected operation ${operation}`);
  }
}

function dependencies(): ProductionSmokeRunnerDependencies {
  return {
    now: () => 0,
    runBoundaryChecks: vi.fn(async () => ({
      "custom-domain-owner-access": "passed" as const,
      "direct-origin-denied": "passed" as const,
    })),
    checkPrivateStorageDenial: vi.fn(async () => "passed" as const),
    callRoute: vi.fn(async (action, executionSha) => ({
      event: routeEvent(action.kind === "inspect-canary-counts"
        ? action.purpose === "baseline" ? "inspect-baseline" : "inspect-cleanup"
        : action.kind === "run-fixed-read-checks" ? "run-fixed-read-checks"
        : action.kind === "write-canary-row" ? "write-row"
        : action.kind === "write-canary-object" ? "write-object"
        : action.kind === "verify-round-trip" ? "verify-round-trip"
        : action.kind === "cleanup-exact-canary" ? "cleanup-exact"
        : "stop"),
      requestId: REQUEST_ID,
      executionSha,
    })),
  };
}

describe("production smoke runner", () => {
  it("drives the bounded canary to a passed terminal with external evidence", async () => {
    const deps = dependencies();
    await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).resolves.toMatchObject({
      outcome: "passed",
      evidence: {
        counts: { baseline: { row: 0, object: 0 }, mutation: { row: 1, object: 2 }, cleanup: { row: 0, object: 0 } },
        checks: {
          "custom-domain-owner-access": "passed",
          "direct-origin-denied": "passed",
          "authenticated-library-read": "passed",
          "runtime-database-read": "passed",
          "private-media-original-read": "passed",
          "media-thumbnail-generated": "passed",
          "private-media-thumbnail-read": "passed",
          "private-storage-direct-denied": "passed",
        },
      },
    });
    expect(deps.runBoundaryChecks).toHaveBeenCalledTimes(1);
    expect(deps.checkPrivateStorageDenial).toHaveBeenCalledTimes(1);
    expect(deps.callRoute).toHaveBeenCalledTimes(7);
    expect(vi.mocked(deps.callRoute).mock.calls.every(([, executionSha]) => executionSha === SHA)).toBe(true);
  });

  it("rejects invalid count evidence before advancing the state machine", async () => {
    const deps = dependencies();
    vi.mocked(deps.callRoute).mockResolvedValueOnce({
      event: { kind: "counts-observed", purpose: "baseline", rowCount: "0", objectCount: 0 },
      requestId: REQUEST_ID,
    });
    await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).rejects.toBeInstanceOf(
      ProductionSmokeTransportError,
    );
  });

  it.each(["write-canary-object", "cleanup-exact-canary"] as const)(
    "retries a lost %s response with the identical fenced action",
    async (lostKind) => {
      const deps = dependencies();
      const implementation = vi.mocked(deps.callRoute).getMockImplementation();
      if (!implementation) throw new Error("missing test implementation");
      let lost = false;
      vi.mocked(deps.callRoute).mockImplementation(async (action, executionSha, signal) => {
        if (action.kind === lostKind && !lost) {
          lost = true;
          throw new ProductionSmokeTransportError("response lost");
        }
        return implementation(action, executionSha, signal);
      });

      await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).resolves.toMatchObject({
        outcome: "passed",
      });
      const attempts = vi.mocked(deps.callRoute).mock.calls.filter(([action]) => action.kind === lostKind);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.[0]).toEqual(attempts[1]?.[0]);
      expect(attempts[0]?.[1]).toBe(SHA);
    },
  );

  it("rejects a dependency that ignores abort when the total deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      vi.mocked(deps.callRoute).mockImplementation(() => new Promise(() => undefined));
      const result = runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps);
      const assertion = expect(result).rejects.toThrow("production smoke total deadline exceeded");
      await vi.advanceTimersByTimeAsync(180_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a terminal result completed after the total deadline", async () => {
    let now = 0;
    const base = dependencies();
    const implementation = vi.mocked(base.callRoute).getMockImplementation();
    if (!implementation) throw new Error("missing test implementation");
    const deps: ProductionSmokeRunnerDependencies = {
      ...base,
      now: () => now,
      callRoute: vi.fn(async (action, executionSha, signal) => {
        const result = await implementation(action, executionSha, signal);
        if (action.kind === "inspect-canary-counts" && action.purpose === "cleanup") now = 180_000;
        return result;
      }),
    };
    await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).rejects.toThrow(
      "production smoke total deadline exceeded",
    );
  });

  it("enforces the total deadline before making a route request", async () => {
    const base = dependencies();
    const deps: ProductionSmokeRunnerDependencies = {
      ...base,
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(180_000),
    };
    await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).rejects.toThrow(
      "production smoke total deadline exceeded",
    );
    expect(deps.callRoute).not.toHaveBeenCalled();
  });

  it("does not retain the run timer when canary input validation fails", async () => {
    vi.useFakeTimers();
    try {
      await expect(runProductionSmokeCanary({ executionSha: "invalid", generation: GENERATION }, dependencies()))
        .rejects.toThrow("execution SHA is invalid");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans the exact canary before reporting a private Storage denial failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.checkPrivateStorageDenial).mockRejectedValue(
      new ProductionSmokeTransportError("private Storage public path was not denied"),
    );

    await expect(runProductionSmokeCanary({ executionSha: SHA, generation: GENERATION }, deps)).resolves.toMatchObject({
      outcome: "failed-cleanup-complete",
      evidence: { counts: { cleanup: { row: 0, object: 0 } } },
    });
    const routeActions = vi.mocked(deps.callRoute).mock.calls.map(([action]) => action.kind);
    expect(routeActions).toContain("cleanup-exact-canary");
    expect(routeActions.at(-1)).toBe("inspect-canary-counts");
    expect(deps.checkPrivateStorageDenial).toHaveBeenCalledTimes(2);
  });

  it("turns an exhausted private Storage denial action into a cleanup event", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const runAction = createProductionSmokeActionRunner({
      customDomain: "game.example.com",
      deploymentOrigin: "https://deployment.example.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_public",
      cfAccessClientId: "client-id",
      cfAccessClientSecret: "client-secret",
      ownerAccessJwt: "owner-jwt",
    }, fetchImpl as typeof fetch);

    await expect(runAction({
      kind: "verify-private-storage-denial",
      generation: GENERATION,
      actionSequence: 6,
      objectPath: "release-smoke-v1/original.png",
    }, SHA, new AbortController().signal)).resolves.toEqual({
      kind: "operation-failed",
      safeDetail: "private Storage public path was not denied",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("makes zero requests when live prerequisites are invalid", () => {
    const fetchImpl = vi.fn();
    expect(() => createProductionSmokeRunner({
      customDomain: "game.example.com",
      deploymentOrigin: "https://deployment.example.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "wrong",
      cfAccessClientId: "id",
      cfAccessClientSecret: "secret",
      ownerAccessJwt: "jwt",
    }, fetchImpl)).toThrow(ProductionSmokePrerequisiteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not mistake an application-level origin response for Vercel protection", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://game.example.com/api/private/ping") return new Response(null, { status: 200 });
      if (target === "https://deployment.example.com/security-error") return new Response(null, { status: 401 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ event: routeEvent(String(body.operation)), requestId: REQUEST_ID });
    });
    const run = createProductionSmokeRunner({
      customDomain: "game.example.com",
      deploymentOrigin: "https://deployment.example.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_public",
      cfAccessClientId: "client-id",
      cfAccessClientSecret: "client-secret",
      ownerAccessJwt: "owner-jwt",
    }, fetchImpl as typeof fetch);

    await expect(run({ executionSha: SHA, generation: GENERATION })).rejects.toThrow(
      "direct origin was not denied",
    );
  });

  it("uses fixed endpoints, sends every action with the execution SHA, and keeps secrets out of the body", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      requests.push({ url: target, init: init ?? {} });
      if (target === "https://game.example.com/api/private/ping") return new Response(null, { status: 200 });
      if (target === "https://deployment.example.com/security-error") {
        return new Response(null, { status: 302, headers: { location: "https://vercel.com/login" } });
      }
      if (target.includes("project.supabase.co/storage/v1/object/public/")) return new Response(null, { status: 400 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ event: routeEvent(String(body.operation)), requestId: REQUEST_ID });
    });
    const run = createProductionSmokeRunner({
      customDomain: "game.example.com",
      deploymentOrigin: "https://deployment.example.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_public",
      cfAccessClientId: "client-id",
      cfAccessClientSecret: "client-secret",
      ownerAccessJwt: "owner-jwt",
    }, fetchImpl as typeof fetch);

    await expect(run({ executionSha: SHA, generation: GENERATION })).resolves.toMatchObject({ outcome: "passed" });
    const routeRequests = requests.filter(({ url }) => url === "https://game.example.com/api/internal/release-smoke");
    expect(routeRequests).toHaveLength(7);
    for (const request of routeRequests) {
      const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
      expect(body.executionSha).toBe(SHA);
      expect(JSON.stringify(body)).not.toContain("client-secret");
      expect(JSON.stringify(body)).not.toContain("owner-jwt");
    }
    expect(requests.map(({ url }) => url)).toEqual(expect.arrayContaining([
      "https://project.supabase.co/storage/v1/object/public/game-media/release-smoke-v1/original.png",
      "https://project.supabase.co/storage/v1/object/public/game-media/release-smoke-v1/thumbnail.webp",
    ]));
    const storageIndex = requests.findIndex(({ url }) => url.includes("/storage/v1/object/public/"));
    const roundTripIndex = requests.findIndex(({ init }) => String(init.body).includes("verify-round-trip"));
    const cleanupIndex = requests.findIndex(({ init }) => String(init.body).includes("cleanup-exact"));
    expect(roundTripIndex).toBeLessThan(storageIndex);
    expect(storageIndex).toBeLessThan(cleanupIndex);
  });
});

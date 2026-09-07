import { describe, expect, it, vi } from "vitest";

import {
  VercelRestConfigurationError,
  VercelRestHttpError,
  VercelRestMalformedJsonError,
  VercelRestNetworkError,
  createVercelRestTransport,
} from "../../scripts/vercel-rest-transport";

const config = {
  teamId: "team_example",
  timeoutMs: 1_000,
  token: "vercel_secret_token",
};

describe("Vercel REST mutation transport", () => {
  it("posts bounded JSON with the team scope and fixed authorization", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ id: "dpl_Example" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const transport = createVercelRestTransport({ ...config, fetchImpl });

    await expect(
      transport.postJson(
        "/v13/deployments",
        { name: "game-base", target: "production" },
        { forceNew: 1 },
      ),
    ).resolves.toEqual({ id: "dpl_Example" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.vercel.com/v13/deployments?forceNew=1&teamId=team_example",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer vercel_secret_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "game-base", target: "production" }),
    });
  });

  it("posts without a body for mutation endpoints whose contract has no JSON payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ id: "dpl_Example" }), { status: 200 }),
    );
    const transport = createVercelRestTransport({ ...config, fetchImpl });

    await expect(
      transport.postJson("/v10/projects/prj_project/promote/dpl_Example"),
    ).resolves.toEqual({ id: "dpl_Example" });

    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: undefined,
      headers: {
        accept: "application/json",
        authorization: "Bearer vercel_secret_token",
      },
    });
    expect(fetchImpl.mock.calls[0]![1]?.headers).not.toHaveProperty(
      "content-type",
    );
  });

  it("uploads exact bytes with caller-declared content headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 200 }),
    );
    const transport = createVercelRestTransport({ ...config, fetchImpl });
    const bytes = Buffer.from([0, 1, 2, 255]);

    await expect(
      transport.postBytes("/v2/files", bytes, {
        "content-length": "4",
        "content-type": "application/octet-stream",
        "x-vercel-digest": "a".repeat(40),
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: bytes,
      headers: {
        accept: "application/json",
        authorization: "Bearer vercel_secret_token",
        "content-length": "4",
        "content-type": "application/octet-stream",
        "x-vercel-digest": "a".repeat(40),
      },
    });
  });

  it("rejects unsafe requests before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 200 }),
    );
    const transport = createVercelRestTransport({ ...config, fetchImpl });

    await expect(
      transport.postJson("https://attacker.invalid", {}, {}),
    ).rejects.toBeInstanceOf(VercelRestConfigurationError);
    await expect(
      transport.postJson("/v13/deployments?teamId=other", {}, {}),
    ).rejects.toBeInstanceOf(VercelRestConfigurationError);
    await expect(
      transport.postBytes("/v2/files", Buffer.alloc(0), {
        authorization: "attacker",
      }),
    ).rejects.toBeInstanceOf(VercelRestConfigurationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps token and request bodies out of HTTP and JSON errors", async () => {
    const secretBody = { metadata: "private_request_body" };
    const forbidden = createVercelRestTransport({
      ...config,
      fetchImpl: async () => new Response("private_response_body", { status: 403 }),
    });
    const httpError = await forbidden
      .postJson("/v13/deployments", secretBody)
      .catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(VercelRestHttpError);
    expect(JSON.stringify(httpError)).not.toContain(config.token);
    expect(JSON.stringify(httpError)).not.toContain(secretBody.metadata);
    expect(JSON.stringify(httpError)).not.toContain("private_response_body");

    const malformed = createVercelRestTransport({
      ...config,
      fetchImpl: async () => new Response("private_response_body", { status: 200 }),
    });
    const jsonError = await malformed
      .postJson("/v13/deployments", secretBody)
      .catch((error: unknown) => error);
    expect(jsonError).toBeInstanceOf(VercelRestMalformedJsonError);
    expect(JSON.stringify(jsonError)).not.toContain(secretBody.metadata);
    expect(JSON.stringify(jsonError)).not.toContain("private_response_body");
  });

  it("aborts an in-flight mutation when its parent action is cancelled", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const transport = createVercelRestTransport({ ...config, fetchImpl });
    const controller = new AbortController();
    const request = transport.postJson(
      "/v13/deployments",
      { target: "production" },
      {},
      controller.signal,
    );
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(VercelRestNetworkError);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  VercelRestConfigurationError,
  VercelRestHttpError,
  VercelRestMalformedJsonError,
  VercelRestNetworkError,
  VercelRestTimeoutError,
  VercelRestUnexpectedResponseError,
  createVercelReadOnlyRestClient,
} from "../../scripts/vercel-read-only-rest-client";

describe("Vercel read-only REST client", () => {
  it("lists project environment variables through the fixed team-scoped endpoint", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://api.vercel.com");
        expect(url.pathname).toBe("/v10/projects/project-id/env");
        expect([...url.searchParams.keys()]).toEqual(["teamId"]);
        expect(url.searchParams.get("teamId")).toBe("team-id");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bearer \S+$/,
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);

        return Response.json({
          envs: [
            {
              id: "env-id",
              key: "SUPABASE_URL",
              target: ["production"],
              type: "encrypted",
              value: "list_value_must_be_discarded",
            },
          ],
        });
      },
    );
    const client = createVercelReadOnlyRestClient({
      fetchImpl,
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    await expect(
      client.listProjectEnvironmentVariables("project-id"),
    ).resolves.toEqual([
      {
        id: "env-id",
        key: "SUPABASE_URL",
        target: ["production"],
        type: "encrypted",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads one decrypted environment value through its documented endpoint", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v1/projects/project%20id/env/env%2Fid");
        expect(url.searchParams.get("teamId")).toBe("team-id");
        expect(init?.method).toBe("GET");
        return Response.json({ value: "fixture-value" });
      },
    );
    const client = createVercelReadOnlyRestClient({
      fetchImpl,
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    await expect(
      client.getProjectEnvironmentVariable("project id", "env/id"),
    ).resolves.toEqual({ value: "fixture-value" });
  });

  it("reads project identity and Git connection state through its documented endpoint", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v9/projects/project-id");
        expect(url.searchParams.get("teamId")).toBe("team-id");
        expect(init?.method).toBe("GET");
        return Response.json({
          gitRepository: null,
          id: "project-id",
          link: null,
          name: "game-base",
        });
      },
    );
    const client = createVercelReadOnlyRestClient({
      fetchImpl,
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    await expect(client.getProject("project-id")).resolves.toEqual({
      gitRepository: null,
      id: "project-id",
      link: null,
      name: "game-base",
    });
  });

  it("fails closed on a non-success response without exposing its body", async () => {
    const secret = "response_body_value_must_not_escape";
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async () => new Response(secret, { status: 403 }),
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestHttpError);
    expect(error).toMatchObject({ name: "VercelRestHttpError", status: 403 });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it("fails closed on a network error without exposing upstream details", async () => {
    const secret = "upstream_authorization_value_must_not_escape";
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async () => {
        throw new Error(secret);
      },
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestNetworkError);
    expect(error).toMatchObject({ name: "VercelRestNetworkError" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it("fails closed when a successful response is not JSON", async () => {
    const secret = "response_secret_must_not_escape";
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async () => new Response(`{${secret}`),
      teamId: "team-id",
      timeoutMs: 100,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestMalformedJsonError);
    expect(error).toMatchObject({ name: "VercelRestMalformedJsonError" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it("aborts and fails closed when the bounded timeout expires", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      },
      teamId: "team-id",
      timeoutMs: 5,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestTimeoutError);
    expect(error).toMatchObject({ name: "VercelRestTimeoutError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("classifies an abort-aware fetch timeout as a timeout rather than a network error", async () => {
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      teamId: "team-id",
      timeoutMs: 5,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestTimeoutError);
  });

  it("keeps the timeout active while reading the response body", async () => {
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    const client = createVercelReadOnlyRestClient({
      fetchImpl: async () => response,
      teamId: "team-id",
      timeoutMs: 5,
      token: "fixture-token",
    });

    const error = await client.getProject("project-id").catch((reason) => reason);

    expect(error).toBeInstanceOf(VercelRestTimeoutError);
  });

  it.each([
    ["environment list", { envs: [{ id: "env-id", key: "KEY" }] }, "list"],
    ["environment value", { value: 42 }, "value"],
    ["project", { id: "project-id", name: "game-base" }, "project"],
  ])(
    "fails closed on an unexpected %s response shape",
    async (_label, body, operation) => {
      const secret = "shape_secret_must_not_escape";
      const client = createVercelReadOnlyRestClient({
        fetchImpl: async () => Response.json({ ...body, ignored: secret }),
        teamId: "team-id",
        timeoutMs: 100,
        token: "fixture-token",
      });
      const request =
        operation === "list"
          ? client.listProjectEnvironmentVariables("project-id")
          : operation === "value"
            ? client.getProjectEnvironmentVariable("project-id", "env-id")
            : client.getProject("project-id");

      const error = await request.catch((reason) => reason);

      expect(error).toBeInstanceOf(VercelRestUnexpectedResponseError);
      expect(error).toMatchObject({ name: "VercelRestUnexpectedResponseError" });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    },
  );

  it.each([
    [{ teamId: "team-id", timeoutMs: 100, token: "" }],
    [{ teamId: "", timeoutMs: 100, token: "fixture-token" }],
    [{ teamId: "team-id", timeoutMs: 0, token: "fixture-token" }],
    [
      {
        teamId: "team-id",
        timeoutMs: Number.POSITIVE_INFINITY,
        token: "fixture-token",
      },
    ],
  ])(
    "rejects an unsafe client configuration before issuing a request",
    (options) => {
      expect(() =>
        createVercelReadOnlyRestClient({
          fetchImpl: vi.fn(),
          ...options,
        }),
      ).toThrow(VercelRestConfigurationError);
    },
  );
});

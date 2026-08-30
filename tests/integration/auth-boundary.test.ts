import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handlePrivateRequest } from "@/shared/auth/private-request";
import { requireOwner } from "@/shared/auth/require-owner";
import { createAccessTokenVerifier } from "@/shared/auth/verify-access-token";

const issuer = "https://puizeru.cloudflareaccess.com";
const audience = "puizeru-production-audience";
const ownerEmail = "owner@example.test";
const ownerSub = "owner-subject";
const validKid = "owner-key";

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let localJwks: JWTVerifyGetKey;

beforeAll(async () => {
  const ownerKeys = await generateKeyPair("RS256", { extractable: true });
  const otherKeys = await generateKeyPair("RS256", { extractable: true });
  privateKey = ownerKeys.privateKey;
  otherPrivateKey = otherKeys.privateKey;

  const publicJwk = await exportJWK(ownerKeys.publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, alg: "RS256", kid: validKid, use: "sig" }],
  };
  localJwks = createLocalJWKSet(jwks);
});

type TokenOverrides = {
  audience?: string;
  email?: string;
  expiresAt?: string;
  issuer?: string;
  includeIssuedAt?: boolean;
  issuedAt?: number;
  kid?: string;
  omitKid?: boolean;
  key?: CryptoKey;
  notBefore?: string;
  subject?: string;
  type?: string;
};

async function signToken(overrides: TokenOverrides = {}) {
  let token = new SignJWT({
    email: overrides.email ?? ownerEmail,
    type: overrides.type ?? "app",
  })
    .setProtectedHeader(
      overrides.omitKid
        ? { alg: "RS256" }
        : { alg: "RS256", kid: overrides.kid ?? validKid },
    )
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? ownerSub)
    .setNotBefore(overrides.notBefore ?? "-1s");

  if (overrides.includeIssuedAt !== false) {
    token = token.setIssuedAt(overrides.issuedAt);
  }
  if (overrides.expiresAt !== "omit") {
    token = token.setExpirationTime(overrides.expiresAt ?? "5m");
  }

  return token.sign(overrides.key ?? privateKey);
}

function makeVerifier(jwks: JWTVerifyGetKey = localJwks) {
  return createAccessTokenVerifier({
    issuer,
    audience,
    ownerEmail,
    ownerSub,
    jwks,
  });
}

async function callBoundary(token?: string, jwks?: JWTVerifyGetKey) {
  const database = vi.fn(async () => undefined);
  const storage = vi.fn(async () => undefined);
  const operation = vi.fn(async () => {
    await database();
    await storage();
    return { status: "ready" };
  });
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  const request = new Request("https://gamebase.example.test/api/private/ping", { headers });

  const response = await handlePrivateRequest(request, {
    verifyAccessToken: makeVerifier(jwks),
    operation,
    onAccessDenied: async () => undefined,
    onUnhandledFailure: async () => undefined,
  });

  return { response, database, storage, operation };
}

describe("private owner boundary", () => {
  it("allows a valid owner token before invoking protected adapters", async () => {
    const result = await callBoundary(await signToken());

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(result.operation).toHaveBeenCalledWith({ sub: "owner-subject" });
    expect(result.database).toHaveBeenCalledOnce();
    expect(result.storage).toHaveBeenCalledOnce();
  });

  it("exposes requireOwner as the reusable authentication boundary", async () => {
    const headers = new Headers({
      "Cf-Access-Jwt-Assertion": await signToken(),
    });

    await expect(requireOwner(headers, makeVerifier())).resolves.toEqual({
      sub: ownerSub,
    });
  });

  const rejectedTokens: Array<[string, () => Promise<string | undefined>]> = [
    ["missing header", async () => undefined],
    ["wrong signature", async () => signToken({ key: otherPrivateKey })],
    ["unknown kid", async () => signToken({ kid: "missing-key" })],
    ["missing kid", async () => signToken({ omitKid: true })],
    ["wrong issuer", async () => signToken({ issuer: "https://wrong.example.test" })],
    ["wrong audience", async () => signToken({ audience: "wrong-audience" })],
    ["wrong type", async () => signToken({ type: "other" })],
    ["expired", async () => signToken({ expiresAt: "-10s" })],
    ["missing expiration", async () => signToken({ expiresAt: "omit" })],
    ["missing issued at", async () => signToken({ includeIssuedAt: false })],
    [
      "issued in the future",
      async () => signToken({ issuedAt: Math.floor(Date.now() / 1000) + 300 }),
    ],
    ["not active", async () => signToken({ notBefore: "5m" })],
    ["service token", async () => signToken({ type: "service_token" })],
    ["wrong email", async () => signToken({ email: "intruder@example.test" })],
    ["wrong subject", async () => signToken({ subject: "intruder-subject" })],
    ["empty subject", async () => signToken({ subject: "" })],
  ];

  it.each(rejectedTokens)("rejects %s without invoking protected adapters", async (_name, token) => {
    const result = await callBoundary(await token());
    const body = await result.response.text();

    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(result.operation).not.toHaveBeenCalled();
    expect(result.database).not.toHaveBeenCalled();
    expect(result.storage).not.toHaveBeenCalled();
    expect(body).toContain("無法驗證存取權限。");
    expect(body).toMatch(/[0-9a-f-]{36}/);
    expect(body).not.toContain(ownerEmail);
    expect(body).not.toContain(issuer);
  });

  it("fails closed when the JWK resolver is unavailable", async () => {
    const unavailableJwks: JWTVerifyGetKey = async () => {
      throw new Error("upstream details must stay private");
    };
    const result = await callBoundary(await signToken(), unavailableJwks);
    const body = await result.response.text();

    expect(result.response.status).toBe(401);
    expect(result.operation).not.toHaveBeenCalled();
    expect(result.database).not.toHaveBeenCalled();
    expect(result.storage).not.toHaveBeenCalled();
    expect(body).not.toContain("upstream details");
  });

  it("names and reports protected operation failures without exposing details", async () => {
    const onUnhandledFailure = vi.fn();
    const request = new Request(
      "https://gamebase.example.test/api/private/ping",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await signToken(),
        },
      },
    );

    const response = await handlePrivateRequest(request, {
      verifyAccessToken: makeVerifier(),
      operation: async () => {
        throw new Error("database connection details");
      },
      onUnhandledFailure,
      onAccessDenied: async () => undefined,
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(onUnhandledFailure).toHaveBeenCalledWith({
      errorCode: "private_operation_failed",
      requestId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
    expect(body).not.toContain("database connection details");
  });

  it("preserves a 401 and safely reports an access-denied observer failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request("https://gamebase.example.test/api/private/ping");

    const response = await handlePrivateRequest(request, {
      verifyAccessToken: makeVerifier(),
      operation: async () => ({ status: "unreachable" }),
      onAccessDenied: async () => {
        throw new Error("observer secret");
      },
      onUnhandledFailure: async () => undefined,
    });

    expect(response.status).toBe(401);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain("failure_observer_failed");
    expect(consoleError.mock.calls[0]?.[0]).not.toContain("observer secret");
    consoleError.mockRestore();
  });

  it("preserves a 500 and safely reports an operation observer failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request(
      "https://gamebase.example.test/api/private/ping",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken() } },
    );

    const response = await handlePrivateRequest(request, {
      verifyAccessToken: makeVerifier(),
      operation: async () => {
        throw new Error("operation secret");
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => {
        throw new Error("observer secret");
      },
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain("failure_observer_failed");
    expect(consoleError.mock.calls[0]?.[0]).not.toContain("observer secret");
    consoleError.mockRestore();
  });
});

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
import { createAccessTokenVerifier } from "@/shared/auth/verify-access-token";

const issuer = "https://puizeru.cloudflareaccess.com";
const audience = "puizeru-production-audience";
const ownerEmail = "owner@example.test";
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
  kid?: string;
  key?: CryptoKey;
  notBefore?: string;
  subject?: string;
  type?: string;
};

async function signToken(overrides: TokenOverrides = {}) {
  return new SignJWT({
    email: overrides.email ?? ownerEmail,
    type: overrides.type ?? "app",
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? validKid })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? "owner-subject")
    .setIssuedAt()
    .setNotBefore(overrides.notBefore ?? "-1s")
    .setExpirationTime(overrides.expiresAt ?? "5m")
    .sign(overrides.key ?? privateKey);
}

function makeVerifier(jwks: JWTVerifyGetKey = localJwks) {
  return createAccessTokenVerifier({ issuer, audience, ownerEmail, jwks });
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

  const rejectedTokens: Array<[string, () => Promise<string | undefined>]> = [
    ["missing header", async () => undefined],
    ["wrong signature", async () => signToken({ key: otherPrivateKey })],
    ["unknown kid", async () => signToken({ kid: "missing-key" })],
    ["wrong issuer", async () => signToken({ issuer: "https://wrong.example.test" })],
    ["wrong audience", async () => signToken({ audience: "wrong-audience" })],
    ["wrong type", async () => signToken({ type: "other" })],
    ["expired", async () => signToken({ expiresAt: "-1s" })],
    ["not active", async () => signToken({ notBefore: "5m" })],
    ["service token", async () => signToken({ type: "service_token" })],
    ["wrong email", async () => signToken({ email: "intruder@example.test" })],
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
});

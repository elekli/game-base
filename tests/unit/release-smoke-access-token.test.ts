import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createAccessTokenVerifier } from "@/shared/auth/verify-access-token";
import { createReleaseSmokeAccessTokenVerifier } from "@/shared/auth/verify-release-smoke-access-token";

const issuer = "https://puizeru.cloudflareaccess.com";
const audience = "puizeru-production-audience";
const commonName = "release-smoke-client-id";
const commonNameSha256 =
  "a8bcb943b72e0453f07f9d2d64a004383f9771ad715a1a2a837eb9afabfe1555";

let privateKey: CryptoKey;
let localJwks: JWTVerifyGetKey;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, alg: "RS256", kid: "release-smoke-key", use: "sig" }],
  };
  localJwks = createLocalJWKSet(jwks);
});

type TokenOverrides = {
  audience?: string;
  commonName?: string;
  expiresAt?: string;
  includeExpiresAt?: boolean;
  includeIssuedAt?: boolean;
  issuedAt?: number;
  issuer?: string;
  kid?: string;
  omitKid?: boolean;
  subject?: string;
  type?: string;
};

async function signToken(overrides: TokenOverrides = {}) {
  let token = new SignJWT({
    type: overrides.type ?? "app",
    common_name: overrides.commonName ?? commonName,
  })
    .setProtectedHeader(
      overrides.omitKid
        ? { alg: "RS256" }
        : { alg: "RS256", kid: overrides.kid ?? "release-smoke-key" },
    )
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? "");

  if (overrides.includeIssuedAt !== false) {
    token = token.setIssuedAt(overrides.issuedAt);
  }
  if (overrides.includeExpiresAt !== false) {
    token = token.setExpirationTime(overrides.expiresAt ?? "5m");
  }
  return token.sign(privateKey);
}

function makeVerifier(maxLifetimeSeconds = 300) {
  return createReleaseSmokeAccessTokenVerifier({
    audience,
    issuer,
    jwks: localJwks,
    commonNameSha256,
    maxLifetimeSeconds,
  });
}

describe("release-smoke access token verifier", () => {
  it("accepts the pinned Cloudflare service principal", async () => {
    await expect(makeVerifier()(await signToken())).resolves.toEqual({
      kind: "release-smoke",
    });
  });

  const rejectedTokens: Array<[string, () => Promise<string>]> = [
    ["non-empty owner subject", () => signToken({ subject: "owner-subject" })],
    ["organization type", () => signToken({ type: "org" })],
    ["wrong common_name", () => signToken({ commonName: "other-service" })],
    ["wrong issuer", () => signToken({ issuer: "https://wrong.example.test" })],
    ["wrong audience", () => signToken({ audience: "wrong-audience" })],
    ["missing kid", () => signToken({ omitKid: true })],
    ["empty kid", () => signToken({ kid: " " })],
    ["expired token", () => signToken({ expiresAt: "-10s" })],
    ["missing issued at", () => signToken({ includeIssuedAt: false })],
    ["missing expiration", () => signToken({ includeExpiresAt: false })],
    ["future issued at", () => signToken({ issuedAt: Math.floor(Date.now() / 1000) + 60 })],
    ["oversized lifetime", () => signToken({ expiresAt: "301s" })],
  ];

  it.each(rejectedTokens)("rejects %s", async (_name, token) => {
    await expect(makeVerifier()(await token())).rejects.toMatchObject({
      name: "AccessDeniedError",
    });
  });

  it("rejects a correctly formed token signed with a non-RS256 algorithm", async () => {
    const secret = await generateSecret("HS256");
    const token = await new SignJWT({ type: "app", common_name: commonName })
      .setProtectedHeader({ alg: "HS256", kid: "release-smoke-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    await expect(makeVerifier()(token)).rejects.toMatchObject({
      name: "AccessDeniedError",
    });
  });

  it("is rejected by the owner verifier", async () => {
    const verifyOwner = createAccessTokenVerifier({
      audience,
      issuer,
      jwks: localJwks,
      ownerEmail: "owner@example.test",
      ownerSub: "owner-subject",
    });

    await expect(verifyOwner(await signToken())).rejects.toMatchObject({
      name: "AccessDeniedError",
    });
  });
});

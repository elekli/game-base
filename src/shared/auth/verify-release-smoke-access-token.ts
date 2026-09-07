import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { AccessDeniedError } from "./access-denied-error";

export type ReleaseSmokeIdentity = Readonly<{ kind: "release-smoke" }>;

export type ReleaseSmokeAccessTokenVerifier = (
  token: string,
) => Promise<ReleaseSmokeIdentity>;

type ReleaseSmokeAccessTokenVerifierConfig = Readonly<{
  audience: string;
  issuer: string;
  jwks: JWTVerifyGetKey;
  commonNameSha256: string;
  maxLifetimeSeconds: number;
}>;

const CLOCK_TOLERANCE_SECONDS = 5;

function matchesSha256(value: string, expected: string) {
  const actualBuffer = Buffer.from(
    createHash("sha256").update(value).digest("hex"),
    "hex",
  );
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function createReleaseSmokeAccessTokenVerifier(
  config: ReleaseSmokeAccessTokenVerifierConfig,
): ReleaseSmokeAccessTokenVerifier {
  return async (token) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, config.jwks, {
        algorithms: ["RS256"],
        audience: config.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: config.issuer,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.trim().length === 0 ||
        payload.type !== "app" ||
        payload.sub !== "" ||
        typeof payload.iat !== "number" ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat > now + CLOCK_TOLERANCE_SECONDS ||
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > config.maxLifetimeSeconds ||
        typeof payload.common_name !== "string" ||
        !matchesSha256(payload.common_name, config.commonNameSha256)
      ) {
        throw new AccessDeniedError();
      }

      return { kind: "release-smoke" };
    } catch {
      throw new AccessDeniedError();
    }
  };
}

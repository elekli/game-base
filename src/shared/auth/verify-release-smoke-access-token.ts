import { createHash, timingSafeEqual } from "node:crypto";
import { errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AccessDeniedError } from "./access-denied-error";

const DENIAL_REASONS = [
  "missing_assertion", "jwt_expired", "audience_mismatch", "issuer_mismatch",
  "signature_invalid", "jwks_unavailable", "jwks_key_unavailable", "missing_kid",
  "invalid_type", "invalid_sub", "invalid_issued_at", "invalid_lifetime",
  "invalid_common_name", "algorithm_not_allowed", "invalid_token", "unknown",
] as const;
export type ReleaseSmokeDenialReason = (typeof DENIAL_REASONS)[number];

// Project at every logging boundary: TypeScript types do not constrain runtime input.
export function projectReleaseSmokeDenialReason(value: unknown): ReleaseSmokeDenialReason {
  return typeof value === "string" && DENIAL_REASONS.some((reason) => reason === value)
    ? value as ReleaseSmokeDenialReason
    : "unknown";
}

export class ReleaseSmokeAccessDeniedError extends AccessDeniedError {
  readonly denialReason: ReleaseSmokeDenialReason;
  constructor(denialReason: ReleaseSmokeDenialReason) {
    super();
    this.denialReason = projectReleaseSmokeDenialReason(denialReason);
  }
}

export function getReleaseSmokeDenialReason(error: unknown): ReleaseSmokeDenialReason {
  return error instanceof ReleaseSmokeAccessDeniedError
    ? projectReleaseSmokeDenialReason(error.denialReason)
    : "unknown";
}

function classifyVerificationError(error: unknown): ReleaseSmokeDenialReason {
  if (error instanceof ReleaseSmokeAccessDeniedError) return getReleaseSmokeDenialReason(error);
  if (error instanceof errors.JWTExpired) return "jwt_expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "aud": return "audience_mismatch";
      case "iss": return "issuer_mismatch";
      case "iat": return "invalid_issued_at";
      case "exp": return "invalid_lifetime";
      default: return "unknown";
    }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return "signature_invalid";
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return "jwks_unavailable";
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) return "jwks_key_unavailable";
  if (error instanceof errors.JOSEAlgNotAllowed) return "algorithm_not_allowed";
  if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid) return "invalid_token";
  return "unknown";
}

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
      if (typeof protectedHeader.kid !== "string" || protectedHeader.kid.trim().length === 0) {
        throw new ReleaseSmokeAccessDeniedError("missing_kid");
      }
      if (payload.type !== "app") throw new ReleaseSmokeAccessDeniedError("invalid_type");
      if (payload.sub !== "") throw new ReleaseSmokeAccessDeniedError("invalid_sub");
      if (
        typeof payload.iat !== "number" ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat > now + CLOCK_TOLERANCE_SECONDS
      ) {
        throw new ReleaseSmokeAccessDeniedError("invalid_issued_at");
      }
      if (
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > config.maxLifetimeSeconds
      ) {
        throw new ReleaseSmokeAccessDeniedError("invalid_lifetime");
      }
      if (
        typeof payload.common_name !== "string" ||
        !matchesSha256(payload.common_name, config.commonNameSha256)
      ) {
        throw new ReleaseSmokeAccessDeniedError("invalid_common_name");
      }

      return { kind: "release-smoke" };
    } catch (error) {
      throw new ReleaseSmokeAccessDeniedError(classifyVerificationError(error));
    }
  };
}

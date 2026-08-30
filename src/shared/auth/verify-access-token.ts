import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { AccessDeniedError } from "./access-denied-error";

export type OwnerIdentity = Readonly<{ sub: string }>;

export type AccessTokenVerifier = (token: string) => Promise<OwnerIdentity>;

type AccessTokenVerifierConfig = Readonly<{
  audience: string;
  issuer: string;
  jwks: JWTVerifyGetKey;
  ownerEmail: string;
  ownerSub: string;
}>;

export function createAccessTokenVerifier(
  config: AccessTokenVerifierConfig,
): AccessTokenVerifier {
  return async (token) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, config.jwks, {
        algorithms: ["RS256"],
        audience: config.audience,
        clockTolerance: 5,
        issuer: config.issuer,
      });

      if (
        typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.trim().length === 0 ||
        payload.type !== "app" ||
        payload.email !== config.ownerEmail ||
        payload.sub !== config.ownerSub ||
        typeof payload.iat !== "number" ||
        payload.iat > Math.floor(Date.now() / 1000) + 5 ||
        typeof payload.exp !== "number"
      ) {
        throw new AccessDeniedError();
      }

      return { sub: payload.sub };
    } catch {
      throw new AccessDeniedError();
    }
  };
}

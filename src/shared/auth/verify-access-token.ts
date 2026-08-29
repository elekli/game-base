import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { AccessDeniedError } from "./access-denied-error";

export type OwnerIdentity = Readonly<{ sub: string }>;

export type AccessTokenVerifier = (token: string) => Promise<OwnerIdentity>;

type AccessTokenVerifierConfig = Readonly<{
  audience: string;
  issuer: string;
  jwks: JWTVerifyGetKey;
  ownerEmail: string;
}>;

export function createAccessTokenVerifier(
  config: AccessTokenVerifierConfig,
): AccessTokenVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, config.jwks, {
        algorithms: ["RS256"],
        audience: config.audience,
        issuer: config.issuer,
      });

      if (
        payload.type !== "app" ||
        payload.email !== config.ownerEmail ||
        typeof payload.sub !== "string" ||
        payload.sub.trim().length === 0
      ) {
        throw new AccessDeniedError();
      }

      return { sub: payload.sub };
    } catch {
      throw new AccessDeniedError();
    }
  };
}


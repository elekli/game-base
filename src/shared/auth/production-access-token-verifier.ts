import "server-only";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import {
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./verify-access-token";

type CloudflareAccessConfig = Readonly<{
  audience: string;
  issuer: string;
  jwksUrl: string;
  ownerEmail: string;
  ownerSub: string;
}>;

type RemoteJwkSetFactory = (url: URL) => JWTVerifyGetKey;

export function createProductionAccessTokenVerifierProvider(
  createJwks: RemoteJwkSetFactory = createRemoteJWKSet,
) {
  let cachedVerifier:
    | Readonly<{ cacheKey: string; verifier: AccessTokenVerifier }>
    | undefined;

  return (config: CloudflareAccessConfig): AccessTokenVerifier => {
    const cacheKey = JSON.stringify([
      config.audience,
      config.issuer,
      config.jwksUrl,
      config.ownerEmail,
      config.ownerSub,
    ]);
    if (cachedVerifier?.cacheKey === cacheKey) return cachedVerifier.verifier;

    const verifier = createAccessTokenVerifier({
      ...config,
      jwks: createJwks(new URL(config.jwksUrl)),
    });
    cachedVerifier = { cacheKey, verifier };
    return verifier;
  };
}

export const getProductionAccessTokenVerifier =
  createProductionAccessTokenVerifierProvider();

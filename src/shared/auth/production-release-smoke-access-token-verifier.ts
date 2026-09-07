import "server-only";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import {
  createReleaseSmokeAccessTokenVerifier,
  type ReleaseSmokeAccessTokenVerifier,
} from "./verify-release-smoke-access-token";

type ReleaseSmokeCloudflareAccessConfig = Readonly<{
  audience: string;
  issuer: string;
  jwksUrl: string;
  commonNameSha256: string;
  maxLifetimeSeconds: number;
}>;

type RemoteJwkSetFactory = (url: URL) => JWTVerifyGetKey;

export function createProductionReleaseSmokeAccessTokenVerifierProvider(
  createJwks: RemoteJwkSetFactory = createRemoteJWKSet,
) {
  let cachedVerifier:
    | Readonly<{
        cacheKey: string;
        verifier: ReleaseSmokeAccessTokenVerifier;
      }>
    | undefined;

  return (
    config: ReleaseSmokeCloudflareAccessConfig,
  ): ReleaseSmokeAccessTokenVerifier => {
    const cacheKey = JSON.stringify([
      config.audience,
      config.issuer,
      config.jwksUrl,
      config.commonNameSha256,
      config.maxLifetimeSeconds,
    ]);
    if (cachedVerifier?.cacheKey === cacheKey) return cachedVerifier.verifier;

    const verifier = createReleaseSmokeAccessTokenVerifier({
      ...config,
      jwks: createJwks(new URL(config.jwksUrl)),
    });
    cachedVerifier = { cacheKey, verifier };
    return verifier;
  };
}

export const getProductionReleaseSmokeAccessTokenVerifier =
  createProductionReleaseSmokeAccessTokenVerifierProvider();

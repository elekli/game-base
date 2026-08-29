import "server-only";
import { createRemoteJWKSet } from "jose";
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

let cachedVerifier:
  | Readonly<{ cacheKey: string; verifier: AccessTokenVerifier }>
  | undefined;

export function getProductionAccessTokenVerifier(
  config: CloudflareAccessConfig,
): AccessTokenVerifier {
  const cacheKey = JSON.stringify(config);
  if (cachedVerifier?.cacheKey === cacheKey) return cachedVerifier.verifier;

  const verifier = createAccessTokenVerifier({
    ...config,
    jwks: createRemoteJWKSet(new URL(config.jwksUrl)),
  });
  cachedVerifier = { cacheKey, verifier };
  return verifier;
}

import { AccessDeniedError } from "./access-denied-error";
import type { AccessTokenVerifier, OwnerIdentity } from "./verify-access-token";

type HeaderReader = Readonly<{
  get: (name: string) => string | null;
}>;

export async function requireOwner(
  headers: HeaderReader,
  verifyAccessToken: AccessTokenVerifier,
): Promise<OwnerIdentity> {
  const token = headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token.trim().length === 0) {
    throw new AccessDeniedError();
  }

  return verifyAccessToken(token);
}

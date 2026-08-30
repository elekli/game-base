import type { JWTVerifyGetKey } from "jose";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createProductionAccessTokenVerifierProvider } from "@/shared/auth/production-access-token-verifier";

const config = {
  audience: "audience",
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/certs",
  ownerEmail: "owner@example.test",
  ownerSub: "owner-subject",
} as const;

describe("production access-token verifier provider", () => {
  it("reuses the verifier and JWK resolver for identical configuration", () => {
    const jwks: JWTVerifyGetKey = async () => {
      throw new Error("unused resolver");
    };
    const createJwks = vi.fn(() => jwks);
    const getVerifier = createProductionAccessTokenVerifierProvider(createJwks);

    const first = getVerifier(config);
    const second = getVerifier({ ...config });

    expect(second).toBe(first);
    expect(createJwks).toHaveBeenCalledOnce();
  });

  it("rebuilds the verifier when the verified configuration changes", () => {
    const jwks: JWTVerifyGetKey = async () => {
      throw new Error("unused resolver");
    };
    const createJwks = vi.fn(() => jwks);
    const getVerifier = createProductionAccessTokenVerifierProvider(createJwks);

    const first = getVerifier(config);
    const second = getVerifier({ ...config, audience: "changed-audience" });

    expect(second).not.toBe(first);
    expect(createJwks).toHaveBeenCalledTimes(2);
  });
});

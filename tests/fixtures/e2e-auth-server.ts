import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const port = Number(process.env.E2E_AUTH_PORT ?? "8787");
const issuer = process.env.E2E_AUTH_ISSUER ?? `http://127.0.0.1:${port}`;
const audience = process.env.E2E_AUTH_AUDIENCE ?? "e2e-audience";
const ownerEmail = process.env.E2E_AUTH_OWNER_EMAIL ?? "owner@example.test";
const ownerSub = process.env.E2E_AUTH_OWNER_SUB ?? "owner-subject";
const keyId = "e2e-owner-key";

const { privateKey, publicKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const publicJwk = await exportJWK(publicKey);

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }

  if (request.url === "/cdn-cgi/access/certs") {
    json(response, 200, {
      keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }],
    });
    return;
  }

  if (request.url === "/token") {
    const token = await new SignJWT({ email: ownerEmail, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(ownerSub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    json(response, 200, { token });
    return;
  }

  json(response, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1");

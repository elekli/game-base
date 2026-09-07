import { createReleaseSmokeRouteHandler } from "./handler";
import { getProductionReleaseSmokeAccessTokenVerifier } from "@/shared/auth/production-release-smoke-access-token-verifier";
import { deploymentBindings } from "@/shared/config/deployment-bindings";
import { getRuntimeConfig } from "@/shared/config/get-runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createReleaseSmokeRouteHandler({
  createCanaryDependencies: () => {
    throw new Error("release-smoke canary dependencies are not implemented");
  },
  getRuntimeConfig,
  getVercelEnvironment: () => process.env.VERCEL_ENV,
  getVerifier: getProductionReleaseSmokeAccessTokenVerifier,
  observeFailure: ({ errorCode, requestId }) => {
    console.warn(
      JSON.stringify({
        event: "release_smoke_request_failed",
        errorCode,
        requestId,
      }),
    );
  },
  productionBinding: deploymentBindings.production,
});

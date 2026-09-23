import {
  ProductionSmokeTransportError,
  verifyProductionOwnerAccess,
} from "./production-smoke-runner";

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ProductionOwnerSessionPreflightError: required environment ${name} is unavailable`);
  return value;
}

try {
  await verifyProductionOwnerAccess({
    customDomain: requiredEnvironment("PRODUCTION_CUSTOM_DOMAIN"),
    ownerAccessJwt: requiredEnvironment("PRODUCTION_SMOKE_OWNER_ACCESS_JWT"),
  }, AbortSignal.timeout(45_000));
  console.log(JSON.stringify({ event: "production_owner_session_preflight_succeeded" }));
} catch (error) {
  if (error instanceof ProductionSmokeTransportError) {
    console.error(`${error.name}: ${error.safeDetail}:${error.errorCode}:${error.httpStatus ?? "unknown-status"}`);
  } else {
    console.error(error instanceof Error ? error.message : "ProductionOwnerSessionPreflightError: unknown failure");
  }
  process.exitCode = 1;
}

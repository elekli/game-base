import { describe, expect, it } from "vitest";
import { ProductionReleaseDiagnosticError, smokeInterruptionDiagnostic } from "../../scripts/production-release-failure-diagnostics";
const SECRET = "SECRET_SENTINEL";
describe("release diagnostic trust boundary", () => {
  it("projects known errors without message, stack, cause or extra keys", () => {
    const error = Object.assign(new ProductionReleaseDiagnosticError(SECRET, "release-route-http-failure", { httpStatus: 401, requestId: "22222222-2222-4222-8222-222222222222" }), { body: SECRET, headers: SECRET, cause: new Error(SECRET) });
    expect(smokeInterruptionDiagnostic(error, "smoke-execution-crash")).toEqual({actionKind: "run-production-smoke", failureCode: "smoke-execution-crash", errorCode: "release-route-http-failure", httpStatus: 401, requestId: "22222222-2222-4222-8222-222222222222"});
    Object.assign(error, { errorCode: SECRET, httpStatus: SECRET, requestId: SECRET });
    expect(JSON.stringify(smokeInterruptionDiagnostic(error, "smoke-execution-crash"))).not.toContain(SECRET);
  });
  it("classifies unknown errors and timeout without inspecting arbitrary details", () => {
    expect(smokeInterruptionDiagnostic(new Error(SECRET), "smoke-execution-crash").errorCode).toBe("unknown-error");
    expect(smokeInterruptionDiagnostic(new Error(SECRET), "smoke-execution-timeout").errorCode).toBe("runner-action-timeout");
  });
});

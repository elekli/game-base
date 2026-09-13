import { describe, expect, it, vi } from "vitest";
import { finalizeProductionApplicationRelease, ProductionApplicationReleasePrerequisiteError } from "../../scripts/production-application-release";
import type { ProductionDeploymentRelease } from "../../scripts/production-deployment-release";
const terminal = (phase = "manual-recovery-required") => ({ phase, failure: "smoke-execution-crash", failureDiagnostic: { actionKind: "run-production-smoke", failureCode: "smoke-execution-crash", errorCode: "boundary-owner-auth-denied" } }) as ProductionDeploymentRelease;
describe("application CLI failure finalization", () => {
  it("persists interrupted evidence exactly once and still fails the release", async () => {
    const write = vi.fn(async () => undefined);
    await expect(finalizeProductionApplicationRelease(terminal(), write)).rejects.toThrow("manual-recovery-required:smoke-execution-crash:boundary-owner-auth-denied");
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("retains primary failure with a secondary flag when writer throws secrets", async () => {
    const write = vi.fn(async () => { throw new Error("SECRET_SENTINEL"); });
    const error = await finalizeProductionApplicationRelease(terminal(), write).catch(error => error);
    expect(error).toBeInstanceOf(ProductionApplicationReleasePrerequisiteError);
    expect(error.evidencePersistenceFailed).toBe(true);
    expect(error.message).toContain("smoke-execution-crash:boundary-owner-auth-denied");
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL");
    expect(error.stack).not.toContain("SECRET_SENTINEL");
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not rewrite evidence already handled by success or verified rollback", async () => {
    const write = vi.fn(async () => undefined);
    await finalizeProductionApplicationRelease(terminal("succeeded"), write);
    await expect(finalizeProductionApplicationRelease({ ...terminal("failed"), failure: "smoke-failed-baseline-restored", evidenceOutcome: "rolled-back" }, write)).rejects.toThrow("smoke-failed-baseline-restored");
    expect(write).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createProductionSmokeRunner, ProductionSmokePrerequisiteError, ProductionSmokeResponseError } from "../../scripts/production-smoke-runner";

const action = { kind: "write-canary-row", rowId: "7355773e-c3b5-4e5d-9f07-55ac0e22f384", identity: `release-smoke-v1:${"a".repeat(40)}`, payloadSha256: "b".repeat(64) } as const;
const input = { principalStatus: "approved" as const, routeAndSchemaStatus: "approved" as const, customDomain: "game.example.com", cfAccessClientId: "id", cfAccessClientSecret: "secret" };

describe("production smoke runner", () => {
  it("makes zero requests while prerequisite status is unresolved", () => {
    const fetchImpl = vi.fn();
    expect(() => createProductionSmokeRunner({ ...input, principalStatus: "unresolved", fetchImpl })).toThrow(ProductionSmokePrerequisiteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects every caller-supplied approved state without sending a request", () => {
    const fetchImpl = vi.fn();
    expect(() => createProductionSmokeRunner({ ...input, fetchImpl })).toThrow(ProductionSmokePrerequisiteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

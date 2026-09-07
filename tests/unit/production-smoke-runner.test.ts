import { describe, expect, it, vi } from "vitest";
import {
  createProductionSmokeRunner,
  ProductionSmokePrerequisiteError,
} from "../../scripts/production-smoke-runner";
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

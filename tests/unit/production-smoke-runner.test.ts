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
  it("parses only a fixed action response", async () => {
    const runner = createProductionSmokeRunner({ ...input, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ kind: "row-written" }), { status: 200 })) });
    await expect(runner.execute(action)).resolves.toEqual({ kind: "row-written" });
  });
  it("fails closed for malformed and unknown responses", async () => {
    for (const body of [{ kind: "unknown" }, { nope: true }]) {
      const runner = createProductionSmokeRunner({ ...input, fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) });
      await expect(runner.execute(action)).rejects.toThrow(ProductionSmokeResponseError);
    }
  });
});

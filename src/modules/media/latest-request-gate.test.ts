import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "./latest-request-gate";

describe("latest request gate", () => {
  it("只允許最新開始的讀取提交，並可在卸載時使讀取失效", () => {
    const gate = createLatestRequestGate();
    const older = gate.begin();
    const newer = gate.begin();

    expect(older()).toBe(false);
    expect(newer()).toBe(true);

    gate.invalidate();
    expect(newer()).toBe(false);
  });
});

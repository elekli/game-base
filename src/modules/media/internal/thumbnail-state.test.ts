import { describe, expect, it } from "vitest";
import { decideThumbnailFailure, thumbnailBackoff } from "./thumbnail-state";

describe("縮圖狀態轉移模型（issue #64 S1-S8／L1-L2）", () => {
  it.each([
    [1, "pending", 1_000],
    [2, "pending", 5_000],
    [3, "failed", null],
  ] as const)("暫時失敗第 %s 次只在前三次週期內退避", (attempt, state, delay) => {
    expect(decideThumbnailFailure({ cycleAttemptCount: attempt, deterministic: false })).toEqual({ state, retryDelayMs: delay });
  });

  it("可重現的內容錯誤不進自動重試", () => {
    expect(decideThumbnailFailure({ cycleAttemptCount: 1, deterministic: true })).toEqual({ state: "failed", retryDelayMs: null });
  });

  it("退避是有界且確定的", () => {
    expect([1, 2, 3].map(thumbnailBackoff)).toEqual([1_000, 5_000, null]);
  });
});

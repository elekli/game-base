import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { PostgresGameStore, type QueryExecutor, sqlState } from "./database-game-store";

describe("PostgresGameStore SQLSTATE", () => {
  it("沿有限 cause 鏈找到被 Drizzle 包裝的 23503", () => {
    const wrapped = new Error("query failed", { cause: new Error("driver failed", { cause: { code: "23503" } }) });
    expect(sqlState(wrapped)).toBe("23503");
  });

  it.each([
    ["deletePlatform", { is_system: false, usage_count: 0 }],
    ["deleteTag", { usage_count: 0 }],
  ] as const)("%s 將被包裝的 23503 轉為共享項目衝突", async (method, row) => {
    const executor: QueryExecutor = { execute: vi.fn().mockResolvedValueOnce([row]).mockRejectedValueOnce(new Error("query failed", { cause: { cause: { code: "23503" } } })) };
    const store = new PostgresGameStore({ execute: executor.execute, transaction: vi.fn() });
    await expect(store[method]("測試項目")).rejects.toThrow("仍有遊戲使用");
  });

  it("將被包裝的 23505 轉為貢獻關係衝突", async () => {
    const wrapped = new Error("query failed", { cause: { cause: { code: "23505" } } });
    const executor: QueryExecutor = {
      execute: vi.fn().mockResolvedValueOnce([{ id: "game-1" }]).mockRejectedValueOnce(wrapped),
    };
    const store = new PostgresGameStore({
      execute: executor.execute,
      transaction: vi.fn(async (callback) => callback(executor)),
    });

    await expect(store.addManualContribution({
      kind: "new",
      gameId: "game-1",
      name: "測試作者",
      entityKind: "person",
      role: "design",
      allowDuplicate: true,
    })).rejects.toThrow("此貢獻者已在此遊戲擁有相同分類");
  });
});

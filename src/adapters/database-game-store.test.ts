import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { PostgresGameStore, type QueryExecutor, sqlState } from "./database-game-store";

const legacySnapshot = {
  ref: { provider: "bgg" as const, medium: "board_game" as const, sourceId: "legacy-game" },
  canonicalUrl: "https://example.test/legacy-game",
  title: "Legacy game",
  localizedTitle: null,
  aliases: [],
  description: null,
  releaseYear: null,
  coverUrl: null,
  categories: [],
  contributors: [{ sourceContributorId: "legacy-author", name: "Legacy author", entityKind: "person" as const, role: "design" as const }],
  minPlayers: null,
  maxPlayers: null,
  supportsSolo: "unknown" as const,
  playtimeMinutes: null,
  weight: null,
  strategyRank: null,
  supportedPlatforms: [],
};

function legacyRow(sourceContributorEntities: unknown[]) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    medium: "board_game",
    display_name: "Legacy game",
    player_count_note: null,
    external_game_identity_id: "22222222-2222-4222-8222-222222222222",
    trashed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    custom_display_name: null,
    snapshot: legacySnapshot,
    source_names: [],
    actual_platforms: [],
    tags: [],
    metrics_identity_id: null,
    source_contributions: [],
    source_contributor_entities: sourceContributorEntities,
    manual_contributions: [],
    cover_ingest_state: null,
  };
}

describe("PostgresGameStore SQLSTATE", () => {
  it.each([
    ["可對應", [{ contributorId: "33333333-3333-4333-8333-333333333333", sourceContributorId: "legacy-author" }], "33333333-3333-4333-8333-333333333333"],
    ["不可對應", [], null],
  ] as const)("legacy snapshot contributor %s本地實體時不偽造 UUID", async (_label, entities, expectedContributorId) => {
    const executor: QueryExecutor = { execute: vi.fn().mockResolvedValueOnce([legacyRow([...entities])]) };
    const store = new PostgresGameStore({ execute: executor.execute, transaction: vi.fn() });

    await expect(store.get("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      contributors: [{ contributorId: expectedContributorId, sourceContributorId: "legacy-author" }],
    });
  });

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

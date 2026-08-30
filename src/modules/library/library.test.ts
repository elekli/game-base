import { describe, expect, it } from "vitest";
import { cleanSharedNames, normalizeSharedName } from "./internal/names";
import { clearIncompatibleSourceCategories, filterAndSortGames } from "./internal/filters";
import type { GameRecord } from "@/modules/games";
import { createLibraryService } from ".";
import { InMemoryGameStore } from "@/modules/games";

function game(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: "game",
    medium: "board_game",
    displayName: "預設名稱",
    customDisplayName: null,
    sourceNames: ["預設名稱"],
    aliases: [],
    actualPlatforms: [],
    tags: [],
    contributors: [],
    playerCountNote: null,
    trashedAt: null,
    externalIdentityId: null,
    snapshot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("library names", () => {
  it("只清理前後空白，英文比較鍵不分大小寫並保留第一次顯示名稱", () => {
    expect(normalizeSharedName("  Steam ")).toBe("steam");
    expect(cleanSharedNames([" Steam ", "steam", " PS5 "])).toEqual(["Steam", "PS5"]);
  });
});

describe("library filters", () => {
  it("同維度取聯集，不同維度取交集，並以名稱與別名搜尋", () => {
    const games = [
      game({ id: "a", displayName: "Alpha", tags: ["合作"], actualPlatforms: ["Steam"] }),
      game({ id: "b", displayName: "Beta", sourceNames: ["Beta"], tags: ["策略"], actualPlatforms: ["PS5"] }),
      game({ id: "c", displayName: "Gamma", aliases: ["Alpha 2"], tags: ["合作"], actualPlatforms: ["Steam"] }),
    ];
    expect(filterAndSortGames(games, { tags: ["合作", "策略"], platforms: ["steam"] }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterAndSortGames(games, { query: "alpha" }).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("來源分類同種類取聯集，不同種類取交集，排序缺值永遠在後", () => {
    const games = [
      game({ id: "missing", snapshot: { ref: { provider: "bgg", medium: "board_game", sourceId: "1" }, canonicalUrl: "https://example.test/1", title: "Missing", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [{ kind: "category", sourceCategoryId: "1", name: "合作" }, { kind: "mechanic", sourceCategoryId: "2", name: "牌庫" }], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] } }),
      game({ id: "ranked", snapshot: { ref: { provider: "bgg", medium: "board_game", sourceId: "2" }, canonicalUrl: "https://example.test/2", title: "Ranked", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [{ kind: "category", sourceCategoryId: "3", name: "合作" }, { kind: "mechanic", sourceCategoryId: "2", name: "牌庫" }], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: 2, strategyRank: 10, supportedPlatforms: [] } }),
    ];
    expect(filterAndSortGames(games, { sourceCategories: [{ kind: "category", sourceCategoryId: "1" }, { kind: "category", sourceCategoryId: "3" }, { kind: "mechanic", sourceCategoryId: "2" }], sort: "strategy_rank" }).map((item) => item.id)).toEqual(["ranked", "missing"]);
  });

  it("未選單一遊戲類型時清除來源分類條件", () => {
    expect(clearIncompatibleSourceCategories(["board_game", "video_game"], [{ kind: "category", sourceCategoryId: "1" }])).toEqual([]);
    expect(clearIncompatibleSourceCategories(["board_game"], [{ kind: "category", sourceCategoryId: "1" }, { kind: "genre", sourceCategoryId: "2" }])).toEqual([{ kind: "category", sourceCategoryId: "1" }]);
  });
});

describe("library service", () => {
  it("編輯電子遊戲時清理共享名稱並保留來源貢獻，桌遊拒絕平台", async () => {
    const store = new InMemoryGameStore();
    const game = await store.createManual("手動條目", "video_game");
    const service = createLibraryService(store);
    const edited = await service.editGame(game.id, { displayName: "  自訂名稱 ", actualPlatforms: [" Steam ", "steam"], tags: [" 合作 ", "合作"] });
    expect(edited.displayName).toBe("自訂名稱");
    expect(edited.actualPlatforms).toEqual(["Steam"]);
    expect(edited.tags).toEqual(["合作"]);
    const board = await store.createManual("桌遊", "board_game");
    await expect(service.editGame(board.id, { actualPlatforms: ["Steam"] })).rejects.toThrow("桌遊不可設定實際平台");
  });

  it("手動貢獻可新增與移除，來源貢獻不會被移除命令刪掉", async () => {
    const store = new InMemoryGameStore();
    const game = await store.createManual("手動條目", "board_game");
    const service = createLibraryService(store);
    const result = await service.addManualContribution({ gameId: game.id, name: "  作者 ", entityKind: "person", role: "design" });
    const withContributor = result.game;
    const manual = withContributor.contributors.find((item) => item.origin === "manual");
    expect(manual?.name).toBe("作者");
    expect(result.possibleDuplicate).toBe(false);
    const removed = await service.removeManualContribution(game.id, manual?.id ?? "missing");
    expect(removed.contributors).toHaveLength(0);
  });

  it("同名手動貢獻只提示可能重複，使用中的平台與標籤不能刪除", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("電子遊戲", "video_game");
    await service.editGame(game.id, { actualPlatforms: ["自訂平台"], tags: ["合作"] });
    const first = await service.addManualContribution({ gameId: game.id, name: "同名作者", entityKind: "person", role: "design" });
    const second = await service.addManualContribution({ gameId: game.id, name: " 同名作者 ", entityKind: "person", role: "art" });
    expect(first.possibleDuplicate).toBe(false);
    expect(second.possibleDuplicate).toBe(true);
    await expect(service.deletePlatform(" 自訂平台 ")).rejects.toThrow("仍有遊戲使用");
    await expect(service.deleteTag("合作")).rejects.toThrow("仍有遊戲使用");
    await expect(service.deletePlatform("PS5")).rejects.toThrow("系統預設平台不可刪除");
  });

  it("多類型篩選會清除不相容的來源分類", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("遊戲", "board_game");
    await expect(service.listGames({ media: ["board_game", "video_game"], sourceCategories: [{ kind: "category", sourceCategoryId: "1" }] })).resolves.toEqual([game]);
  });
});

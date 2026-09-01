import { describe, expect, it } from "vitest";
import { cleanSharedNames, normalizeSharedName } from "./internal/names";
import { clearIncompatibleSourceCategories, filterAndSortGames } from "./internal/filters";
import type { GameRecord, Medium } from "@/modules/games";
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
    coverIngestState: null,
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
  it("遊戲媒介以同維度聯集篩選", () => {
    const games = [
      game({ id: "a", medium: "board_game" }),
      game({ id: "b", medium: "video_game" }),
    ];
    expect(filterAndSortGames(games, { media: ["video_game", "board_game"] }).map((item) => item.id)).toEqual(["a", "b"]);
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

  it("三種數值排序均將空值置後，並以名稱與識別碼穩定排序", () => {
    const games = [
      game({ id: "z", displayName: "相同", snapshot: { ref: { provider: "bgg", medium: "board_game", sourceId: "1" }, canonicalUrl: "https://example.test/1", title: "相同", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: 2, strategyRank: 20, supportedPlatforms: [] } }),
      game({ id: "a", displayName: "相同", snapshot: { ref: { provider: "bgg", medium: "board_game", sourceId: "2" }, canonicalUrl: "https://example.test/2", title: "相同", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: 2, strategyRank: 10, supportedPlatforms: [] } }),
      game({ id: "missing", displayName: "缺值", snapshot: { ref: { provider: "bgg", medium: "board_game", sourceId: "3" }, canonicalUrl: "https://example.test/3", title: "缺值", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] } }),
    ];
    expect(filterAndSortGames(games, { sort: "weight_asc" }).map((item) => item.id)).toEqual(["a", "z", "missing"]);
    expect(filterAndSortGames(games, { sort: "weight_desc" }).map((item) => item.id)).toEqual(["a", "z", "missing"]);
    expect(filterAndSortGames(games, { sort: "strategy_rank" }).map((item) => item.id)).toEqual(["a", "z", "missing"]);
  });
});

describe("library service", () => {
  it("將收藏庫查詢交給 adapter，且在多媒介時清除不相容條件", async () => {
    const queries: unknown[] = [];
    const store = {
      async listLibraryGames(query: unknown) {
        queries.push(query);
        return [game({ id: "adapter-result" })];
      },
    } as unknown as import("@/modules/games").GameStore;
    const service = createLibraryService(store);

    await expect(service.listGames({
      media: ["board_game", "video_game"],
      sourceCategories: [{ kind: "category", sourceCategoryId: "1" }],
      weightMin: 2,
      sort: "weight_asc",
    })).resolves.toEqual([game({ id: "adapter-result" })]);
    expect(queries).toEqual([{
      media: ["board_game", "video_game"],
      sourceCategories: [],
      weightMin: undefined,
      weightMax: undefined,
      sort: "name",
    }]);
  });

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

  it("首次手動貢獻會建立全庫 contributor 實體", async () => {
    const store = new InMemoryGameStore();
    const game = await store.createManual("手動條目", "board_game");
    const service = createLibraryService(store);
    const result = await service.addManualContribution({ kind: "new", gameId: game.id, name: "  作者 ", entityKind: "person", role: "design", allowDuplicate: false });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created contribution");
    const withContributor = result.game;
    const manual = withContributor.contributors.find((item) => item.origin === "manual");
    expect(manual?.name).toBe("作者");
    const removed = await service.removeManualContribution(game.id, manual?.id ?? "missing");
    expect(removed.contributors).toHaveLength(0);
  });

  it("同名未確認時回傳 matches 且不寫 contributor 或關係", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("電子遊戲", "video_game");
    const first = await service.addManualContribution({ kind: "new", gameId: game.id, name: "同名作者", entityKind: "person", role: "design", allowDuplicate: false });
    if (first.status !== "created") throw new Error("expected initial contributor");
    const before = await store.get(game.id);
    const second = await service.addManualContribution({ kind: "new", gameId: game.id, name: " 同名作者 ", entityKind: "person", role: "art", allowDuplicate: false });

    expect(second).toMatchObject({ status: "confirmation_required", matches: [{ contributorId: first.game.contributors[0].contributorId, name: "同名作者", rolesOnGame: ["design"] }] });
    expect(await store.get(game.id)).toEqual(before);
    expect(await service.findContributorMatches(game.id, " 同名作者 ")).toHaveLength(1);
  });

  it("可重用同一 contributor 到同一遊戲的不同 role", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("電子遊戲", "video_game");
    const created = await service.addManualContribution({ kind: "new", gameId: game.id, name: "同名作者", entityKind: "person", role: "design", allowDuplicate: false });
    if (created.status !== "created") throw new Error("expected initial contributor");
    const contributorId = created.game.contributors[0].contributorId;

    const reused = await service.addManualContribution({ kind: "existing", gameId: game.id, contributorId, role: "art" });

    expect(reused.status).toBe("created");
    if (reused.status !== "created") throw new Error("expected reused contributor");
    expect(reused.game.contributors.filter((item) => item.origin === "manual").map((item) => [item.contributorId, item.role])).toEqual([[contributorId, "design"], [contributorId, "art"]]);
    await expect(service.addManualContribution({ kind: "existing", gameId: game.id, contributorId, role: "design" })).rejects.toThrow("相同分類");
  });

  it("確認同名後仍可建立不同 contributor 實體", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("電子遊戲", "video_game");
    const first = await service.addManualContribution({ kind: "new", gameId: game.id, name: "同名作者", entityKind: "person", role: "design", allowDuplicate: false });
    if (first.status !== "created") throw new Error("expected initial contributor");

    const duplicate = await service.addManualContribution({ kind: "new", gameId: game.id, name: " 同名作者 ", entityKind: "person", role: "art", allowDuplicate: true });

    expect(duplicate.status).toBe("created");
    if (duplicate.status !== "created") throw new Error("expected duplicate contributor");
    const manualContributorIds = duplicate.game.contributors.filter((item) => item.origin === "manual").map((item) => item.contributorId);
    expect(manualContributorIds).toHaveLength(2);
    expect(manualContributorIds[1]).not.toBe(first.game.contributors[0].contributorId);
  });

  it("來源 contributor 可被手動關係重用，且 refresh 保留手動關係", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const snapshot = { ref: { provider: "bgg" as const, medium: "board_game" as const, sourceId: "source-contributor-reuse" }, canonicalUrl: "https://example.test/source-contributor-reuse", title: "來源遊戲", localizedTitle: null, aliases: [], description: null, releaseYear: null, coverUrl: null, categories: [], contributors: [{ sourceContributorId: "source-author", name: "來源作者", entityKind: "person" as const, role: "design" as const }], minPlayers: null, maxPlayers: null, supportsSolo: "unknown" as const, playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] };
    const created = await store.createFromSource(snapshot.ref, snapshot);
    const sourceContributor = created.game.contributors[0];
    expect(await service.findContributorMatches(created.game.id, " 來源作者 ")).toMatchObject([{ contributorId: sourceContributor.contributorId, provider: "bgg", sourceContributorId: "source-author", rolesOnGame: ["design"] }]);

    const reused = await service.addManualContribution({ kind: "existing", gameId: created.game.id, contributorId: sourceContributor.contributorId, role: "art" });
    if (reused.status !== "created") throw new Error("expected source contributor reuse");
    const refreshed = await store.refreshSource(created.game.id, { ...snapshot, title: "來源遊戲更新" });

    expect(reused.game.contributors.find((item) => item.origin === "manual")?.contributorId).toBe(sourceContributor.contributorId);
    expect(refreshed.contributors.filter((item) => item.origin === "manual").map((item) => item.contributorId)).toEqual([sourceContributor.contributorId]);
  });

  it("使用中的平台與標籤不能刪除", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("電子遊戲", "video_game");
    await service.editGame(game.id, { actualPlatforms: ["自訂平台"], tags: ["合作"] });
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

  it("只在單一媒介讀取來源分類 facet", async () => {
    const calls: Medium[] = [];
    const store = {
      async listSourceCategoryFacets(medium: Medium) {
        calls.push(medium);
        return [];
      },
    } as unknown as import("@/modules/games").GameStore;
    const service = createLibraryService(store);

    await expect(service.listSourceCategoryFacets([])).resolves.toEqual([]);
    await expect(service.listSourceCategoryFacets(["board_game", "video_game"])).resolves.toEqual([]);
    await expect(service.listSourceCategoryFacets(["video_game"])).resolves.toEqual([]);
    expect(calls).toEqual(["video_game"]);
  });
});

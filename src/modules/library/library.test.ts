import { describe, expect, it } from "vitest";
import { cleanSharedNames, normalizeSharedName } from "./internal/names";
import { clearIncompatibleSourceCategories, filterAndSortGames } from "./internal/filters";
import type { GameRecord, Medium, SourceSnapshot } from "@/modules/games";
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
  it("同分類多位 contributor 取聯集，跨分類取交集，且身分不以同名合併", () => {
    const contribution = (contributorId: string, role: "design" | "art" | "publisher", name = "同名貢獻者") => ({
      id: `${role}-${contributorId}`,
      contributorId,
      name,
      entityKind: "person" as const,
      role,
      origin: "manual" as const,
      provider: null,
      sourceContributorId: null,
    });
    const games = [
      game({ id: "design-a-art", contributors: [contribution("design-a", "design"), contribution("art-a", "art")] }),
      game({ id: "design-b-art", contributors: [contribution("design-b", "design"), contribution("art-a", "art")] }),
      game({ id: "design-a-only", contributors: [contribution("design-a", "design")] }),
      game({ id: "same-name-wrong-id", contributors: [contribution("design-other", "design")] }),
    ];

    expect(filterAndSortGames(games, { contributorRoles: [
      { role: "design", contributorIds: ["design-a"] },
      { role: "design", contributorIds: ["design-b"] },
      { role: "art", contributorIds: ["art-a"] },
    ] }).map((item) => item.id)).toEqual(["design-a-art", "design-b-art"]);
    expect(filterAndSortGames(games, { contributorRoles: [] })).toHaveLength(4);
  });

  it("只以本地 contributor UUID 篩選，同名實體不會互相命中", () => {
    const contribution = (contributorId: string) => ({
      id: `contribution-${contributorId}`,
      contributorId,
      name: "同名作者",
      entityKind: "person" as const,
      role: "design" as const,
      origin: "manual" as const,
      provider: null,
      sourceContributorId: null,
    });
    const games = [
      game({ id: "selected", contributors: [contribution("contributor-a")] }),
      game({ id: "same-name", contributors: [contribution("contributor-b")] }),
      game({ id: "unrelated" }),
    ];

    expect(filterAndSortGames(games, { contributorIds: ["contributor-a"] }).map((item) => item.id)).toEqual(["selected"]);
    expect(filterAndSortGames(games, { contributorIds: [] })).toHaveLength(3);
  });

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
  it("列出非回收遊戲使用中的分類化 contributor facet，並保留同名不同身分", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const source = (sourceId: string, contributorId: string): SourceSnapshot => ({
      ref: { provider: "bgg", medium: "board_game", sourceId },
      canonicalUrl: `https://example.test/${sourceId}`,
      title: `facet ${sourceId}`,
      localizedTitle: null,
      aliases: [],
      description: null,
      releaseYear: null,
      coverUrl: null,
      categories: [],
      contributors: [{ sourceContributorId: contributorId, name: "同名作者", entityKind: "person", role: "design" }],
      minPlayers: null,
      maxPlayers: null,
      supportsSolo: "unknown",
      playtimeMinutes: null,
      weight: null,
      strategyRank: null,
      supportedPlatforms: [],
    });
    const active = await store.createFromSource(source("facet-active", "facet-author-a").ref, source("facet-active", "facet-author-a"));
    const trashed = await store.createFromSource(source("facet-trashed", "facet-author-b").ref, source("facet-trashed", "facet-author-b"));
    await store.trash(trashed.game.id);

    await expect(service.listContributorFacets()).resolves.toEqual([{ contributorId: active.game.contributors[0].contributorId, name: "同名作者", entityKind: "person", role: "design" }]);
  });

  it("以名稱部分搜尋並將實際平台與自由標籤依同維度 OR、跨維度 AND 篩選", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const source: SourceSnapshot = {
      ref: { provider: "igdb", medium: "video_game", sourceId: "library-search" },
      canonicalUrl: "https://example.test/library-search",
      title: "The Legend of Zelda",
      localizedTitle: "薩爾達傳說",
      aliases: ["Zelda BOTW"],
      description: null,
      releaseYear: null,
      coverUrl: null,
      categories: [],
      contributors: [],
      minPlayers: null,
      maxPlayers: null,
      supportsSolo: "unknown",
      playtimeMinutes: null,
      weight: null,
      strategyRank: null,
      supportedPlatforms: ["PC"],
    };
    const zelda = await store.createFromSource(source.ref, source);
    const hades = await store.createManual("Hades", "video_game");
    const party = await store.createManual("派對桌遊", "board_game");
    await service.editGame(zelda.game.id, { displayName: "曠野之息", actualPlatforms: ["Nintendo Switch"], tags: ["劇情向"] });
    await service.editGame(hades.id, { actualPlatforms: ["Steam"], tags: ["劇情向", "動作"] });
    await service.editGame(party.id, { tags: ["派對"] });

    await expect(service.listGames({ search: "zelDA" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(service.listGames({ search: "薩爾達" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(service.listGames({ actualPlatforms: ["Steam", "Nintendo Switch"], tags: ["劇情向"] })).resolves.toHaveLength(2);
    await expect(service.listGames({ actualPlatforms: ["Steam"], tags: ["派對", "動作"] })).resolves.toMatchObject([{ id: hades.id }]);
    await expect(service.listGames({ actualPlatforms: [], tags: [] })).resolves.toHaveLength(3);
  });

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
    if (!contributorId) throw new Error("expected local contributor id");

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
    if (!sourceContributor.contributorId) throw new Error("expected local source contributor id");
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

  it("回收區遊戲仍計入共享平台與標籤使用數，且關係未移除前不能刪除", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("回收區共享項目", "video_game");
    await service.editGame(game.id, { actualPlatforms: ["舊平台"], tags: ["舊標籤"] });
    await store.trash(game.id);

    expect(await service.listPlatforms()).toEqual(expect.arrayContaining([{ name: "舊平台", usageCount: 1, isSystem: false }]));
    expect(await service.listTags()).toEqual([{ name: "舊標籤", usageCount: 1, isSystem: false }]);
    await expect(service.deletePlatform("舊平台")).rejects.toThrow("仍有遊戲使用");
    await expect(service.deleteTag("舊標籤")).rejects.toThrow("仍有遊戲使用");

    await service.editGame(game.id, { actualPlatforms: [], tags: [] });
    expect(await service.listPlatforms()).toEqual(expect.arrayContaining([{ name: "舊平台", usageCount: 0, isSystem: false }]));
    expect(await service.listTags()).toEqual([{ name: "舊標籤", usageCount: 0, isSystem: false }]);
    await service.deletePlatform(" 舊平台 ");
    await service.deleteTag("舊標籤");
    expect(await service.listPlatforms()).not.toEqual(expect.arrayContaining([{ name: "舊平台", usageCount: 0, isSystem: false }]));
    expect(await service.listTags()).toEqual([]);
  });

  it("InMemory 共享項目以第一次顯示名稱合併大小寫，零使用時仍可刪除", async () => {
    const store = new InMemoryGameStore();
    const service = createLibraryService(store);
    const game = await store.createManual("共享項目登錄", "video_game");
    await service.editGame(game.id, { actualPlatforms: [" Custom Platform "], tags: [" Custom Tag "] });
    await service.editGame(game.id, { actualPlatforms: ["custom platform"], tags: ["custom tag"] });

    expect(await service.listPlatforms()).toEqual(expect.arrayContaining([{ name: "Custom Platform", usageCount: 1, isSystem: false }]));
    expect(await service.listTags()).toEqual([{ name: "Custom Tag", usageCount: 1, isSystem: false }]);
    await service.editGame(game.id, { actualPlatforms: [], tags: [] });
    expect(await service.listPlatforms()).toEqual(expect.arrayContaining([{ name: "Custom Platform", usageCount: 0, isSystem: false }]));
    expect(await service.listTags()).toEqual([{ name: "Custom Tag", usageCount: 0, isSystem: false }]);
    await service.deletePlatform(" CUSTOM PLATFORM ");
    await service.deleteTag(" custom tag ");
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

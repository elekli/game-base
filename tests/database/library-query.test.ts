import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";
import { createLibraryService } from "@/modules/library";
import type { SourceSnapshot } from "@/modules/games";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;
if (!directDatabaseUrl) throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");

const requiredDatabaseUrl: string = directDatabaseUrl;
const options = { max: 1, prepare: false, onnotice: () => undefined } as const;

function runtimeUrl(): string {
  const url = new URL(requiredDatabaseUrl);
  url.searchParams.set("options", "-c role=app_runtime");
  return url.toString();
}

function bggSnapshot(sourceId: string, title: string, categories: SourceSnapshot["categories"], weight: number | null, strategyRank: number | null, contributors: SourceSnapshot["contributors"] = []): SourceSnapshot {
  return {
    ref: { provider: "bgg", medium: "board_game", sourceId },
    canonicalUrl: `https://boardgamegeek.com/boardgame/${sourceId}`,
    title,
    localizedTitle: null,
    aliases: [],
    description: null,
    releaseYear: null,
    coverUrl: null,
    categories,
    contributors,
    minPlayers: null,
    maxPlayers: null,
    supportsSolo: "unknown",
    playtimeMinutes: null,
    weight,
    strategyRank,
    supportedPlatforms: [],
  };
}

function igdbSnapshot(sourceId: string): SourceSnapshot {
  return {
    ref: { provider: "igdb", medium: "video_game", sourceId },
    canonicalUrl: `https://igdb.com/games/${sourceId}`,
    title: "SQL 篩選測試：IGDB",
    localizedTitle: null,
    aliases: [],
    description: null,
    releaseYear: null,
    coverUrl: null,
    categories: [
      { kind: "genre", sourceCategoryId: "sql-query-genre", name: "角色扮演" },
      { kind: "keyword", sourceCategoryId: "sql-query-keyword", name: "不得出現" },
    ],
    contributors: [],
    minPlayers: null,
    maxPlayers: null,
    supportsSolo: "unknown",
    playtimeMinutes: null,
    weight: null,
    strategyRank: null,
    supportedPlatforms: [],
  };
}

let controlDatabase!: ReturnType<typeof postgres>;
let runtimeDatabase!: ReturnType<typeof postgres>;
let applicationDatabase!: ReturnType<typeof createDatabase>;
let store!: PostgresGameStore;
let library!: ReturnType<typeof createLibraryService>;

async function cleanTestData(): Promise<void> {
  await runtimeDatabase.unsafe("delete from app_private.external_game_categories where category_id in (select id from app_private.source_categories where source_category_id like 'sql-query-%')");
  await runtimeDatabase.unsafe("delete from app_private.games where display_name like 'SQL 篩選測試：%'");
  await runtimeDatabase.unsafe("delete from app_private.external_game_identities where snapshot ->> 'title' like 'SQL 篩選測試：%'");
  await runtimeDatabase.unsafe("delete from app_private.source_categories where source_category_id like 'sql-query-%'");
  await runtimeDatabase.unsafe("delete from app_private.platforms where name like 'SQL 篩選測試：%'");
  await runtimeDatabase.unsafe("delete from app_private.tags where name like 'SQL 篩選測試：%'");
  await runtimeDatabase.unsafe("delete from app_private.contributors where source_contributor_id like 'sql-query-contributor-%' or (source_provider is null and name like 'SQL 篩選測試：%')");
}

beforeAll(async () => {
  controlDatabase = postgres(requiredDatabaseUrl, options);
  await controlDatabase.unsafe("grant app_runtime to postgres");
  runtimeDatabase = postgres(runtimeUrl(), options);
  applicationDatabase = createDatabase(runtimeUrl());
  store = new PostgresGameStore(applicationDatabase.db);
  library = createLibraryService(store);
  await cleanTestData();
});

afterEach(cleanTestData);

afterAll(async () => {
  await cleanTestData();
  await applicationDatabase.close();
  await runtimeDatabase.end();
  await controlDatabase.unsafe("revoke app_runtime from postgres");
  await controlDatabase.end();
});

describe("Postgres 收藏庫 SQL 查詢", () => {
  it("以最新 BGG 指標讀取、篩選與排序，分類維度在 SQL 內維持 OR／AND", async () => {
    const alphaSnapshot = bggSnapshot("981001", "SQL 篩選測試：Alpha", [
      { kind: "category", sourceCategoryId: "sql-query-category-a", name: "合作" },
      { kind: "mechanic", sourceCategoryId: "sql-query-mechanic", name: "牌庫構築" },
    ], 4.5, 100);
    const betaSnapshot = bggSnapshot("981002", "SQL 篩選測試：Beta", [
      { kind: "category", sourceCategoryId: "sql-query-category-b", name: "奇幻" },
      { kind: "mechanic", sourceCategoryId: "sql-query-mechanic", name: "牌庫構築" },
    ], 2.5, 20);
    const gammaSnapshot = bggSnapshot("981003", "SQL 篩選測試：Gamma", [
      { kind: "category", sourceCategoryId: "sql-query-category-a", name: "合作" },
      { kind: "mechanic", sourceCategoryId: "sql-query-worker", name: "工人擺放" },
    ], null, null);
    const trashedSnapshot = bggSnapshot("981004", "SQL 篩選測試：已移入回收區", [
      { kind: "category", sourceCategoryId: "sql-query-hidden", name: "不得出現" },
    ], 1, 1);
    const videoSnapshot = igdbSnapshot("981005");
    const alpha = await store.createFromSource(alphaSnapshot.ref, alphaSnapshot);
    const beta = await store.createFromSource(betaSnapshot.ref, betaSnapshot);
    const gamma = await store.createFromSource(gammaSnapshot.ref, gammaSnapshot);
    const trashed = await store.createFromSource(trashedSnapshot.ref, trashedSnapshot);
    const video = await store.createFromSource(videoSnapshot.ref, videoSnapshot);
    await store.trash(trashed.game.id);

    await runtimeDatabase.unsafe(
      "update app_private.bgg_current_metrics set weight = case identity_id when $1 then 1.2 when $2 then null when $3 then 3.2 end, strategy_rank = case identity_id when $1 then 300 when $2 then null when $3 then 5 end where identity_id in ($1, $2, $3)",
      [alpha.game.externalIdentityId, beta.game.externalIdentityId, gamma.game.externalIdentityId],
    );
    await runtimeDatabase.unsafe(
      "insert into app_private.bgg_current_metrics (identity_id, weight, strategy_rank, last_successful_sync_at) values ($1, 4.9, 999, now()) on conflict (identity_id) do update set weight = excluded.weight, strategy_rank = excluded.strategy_rank, last_successful_sync_at = excluded.last_successful_sync_at",
      [video.game.externalIdentityId],
    );

    expect((await store.get(alpha.game.id))?.snapshot).toMatchObject({ weight: 1.2, strategyRank: 300 });
    expect((await store.get(beta.game.id))?.snapshot).toMatchObject({ weight: null, strategyRank: null });
    expect((await store.get(video.game.id))?.snapshot).toMatchObject({ weight: null, strategyRank: null });
    expect((await library.listGames({ media: ["board_game"], weightMax: 2 })).map((game) => game.id)).toEqual([alpha.game.id]);
    expect((await library.listGames({ media: ["board_game"], sourceCategories: [
      { kind: "category", sourceCategoryId: "sql-query-category-a" },
      { kind: "category", sourceCategoryId: "sql-query-category-b" },
      { kind: "mechanic", sourceCategoryId: "sql-query-mechanic" },
    ] })).map((game) => game.id)).toEqual([alpha.game.id, beta.game.id]);
    expect((await library.listGames({ media: ["board_game"], sort: "weight_asc" })).map((game) => game.id)).toEqual([alpha.game.id, gamma.game.id, beta.game.id]);
    expect((await library.listGames({ media: ["board_game"], sort: "weight_desc" })).map((game) => game.id)).toEqual([gamma.game.id, alpha.game.id, beta.game.id]);
    expect((await library.listGames({ media: ["board_game"], sort: "strategy_rank" })).map((game) => game.id)).toEqual([gamma.game.id, alpha.game.id, beta.game.id]);
    expect((await library.listGames({ media: ["board_game", "video_game"], sourceCategories: [{ kind: "category", sourceCategoryId: "sql-query-hidden" }], weightMin: 4, sort: "weight_desc" })).map((game) => game.id)).toEqual([alpha.game.id, beta.game.id, gamma.game.id, video.game.id]);
  });

  it("facet 只讀取單一媒介的白名單來源分類，且不回收全量 GameRecord", async () => {
    const snapshot = igdbSnapshot("981006");
    await store.createFromSource(snapshot.ref, snapshot);

    await expect(library.listSourceCategoryFacets(["board_game", "video_game"])).resolves.toEqual([]);
    await expect(library.listSourceCategoryFacets(["video_game"])).resolves.toEqual([
      { kind: "genre", sourceCategoryId: "sql-query-genre", name: "角色扮演" },
    ]);
  });

  it("以名稱部分搜尋並在實際平台與自由標籤維度維持 OR／AND", async () => {
    const snapshot: SourceSnapshot = {
      ...igdbSnapshot("981007"),
      title: "SQL 篩選測試：The Legend of Zelda",
      localizedTitle: "SQL 篩選測試：薩爾達傳說",
      aliases: ["Breath of the Wild"],
      supportedPlatforms: ["來源 PC"],
      contributors: [{ sourceContributorId: "sql-query-contributor-video", name: "SQL 篩選測試：電子設計者", entityKind: "company", role: "design" }],
    };
    const zelda = await store.createFromSource(snapshot.ref, snapshot);
    const hades = await store.createManual("SQL 篩選測試：Hades", "video_game");
    const party = await store.createManual("SQL 篩選測試：派對桌遊", "board_game");
    await store.edit(zelda.game.id, { displayName: "SQL 篩選測試：曠野之息", actualPlatforms: ["SQL 篩選測試：Switch"], tags: ["SQL 篩選測試：劇情向"] });
    await store.edit(hades.id, { actualPlatforms: ["SQL 篩選測試：Steam"], tags: ["SQL 篩選測試：劇情向", "SQL 篩選測試：動作"] });
    await store.edit(party.id, { tags: ["SQL 篩選測試：派對"] });

    await expect(library.listGames({ search: "zELDa" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(library.listGames({ search: "breath of" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(library.listGames({ search: "薩爾達" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(library.listGames({ actualPlatforms: ["SQL 篩選測試：Steam", "SQL 篩選測試：Switch"], tags: ["SQL 篩選測試：劇情向"] })).resolves.toHaveLength(2);
    await expect(library.listGames({ actualPlatforms: ["sql 篩選測試：steam"], tags: ["SQL 篩選測試：派對", "SQL 篩選測試：動作"] })).resolves.toMatchObject([{ id: hades.id }]);
    await expect(library.listGames({ actualPlatforms: ["來源 PC"] })).resolves.toEqual([]);
    await expect(library.listGames({ actualPlatforms: [], tags: [] })).resolves.toHaveLength(3);
    const videoContributorId = (await store.get(zelda.game.id))?.contributors[0]?.contributorId;
    await expect(library.listGames({
      search: "zelDA",
      media: ["video_game"],
      actualPlatforms: ["SQL 篩選測試：Switch"],
      tags: ["SQL 篩選測試：劇情向"],
      sourceCategories: [{ kind: "genre", sourceCategoryId: "sql-query-genre" }],
      contributorRoles: [{ role: "design", contributorIds: [videoContributorId ?? "missing"] }],
      sort: "recent",
    })).resolves.toMatchObject([{ id: zelda.game.id }]);
  });

  it("以本地 contributor UUID 組合收藏庫條件，同名不同實體不合併且排除回收區", async () => {
    const designA = { sourceContributorId: "sql-query-contributor-design-a", name: "SQL 篩選測試：同名作者", entityKind: "person" as const, role: "design" as const };
    const designB = { ...designA, sourceContributorId: "sql-query-contributor-design-b" };
    const distinctContributor = { ...designA, sourceContributorId: "sql-query-contributor-distinct" };
    const art = { sourceContributorId: "sql-query-contributor-art", name: "SQL 篩選測試：共同美術", entityKind: "person" as const, role: "art" as const };
    const publisher = { sourceContributorId: "sql-query-contributor-publisher", name: "SQL 篩選測試：共同發行", entityKind: "company" as const, role: "publisher" as const };
    const categories = [{ kind: "category", sourceCategoryId: "sql-query-contributor-category", name: "SQL 篩選測試：貢獻分類" }];
    const firstSnapshot = bggSnapshot("981021", "SQL 篩選測試：貢獻者一", categories, 2.5, 20, [designA, art, publisher]);
    const secondSnapshot = bggSnapshot("981022", "SQL 篩選測試：貢獻者二", categories, 3.5, 10, [designB, art, publisher]);
    const sameNameSnapshot = bggSnapshot("981023", "SQL 篩選測試：同名不同人", [], null, null, [distinctContributor]);
    const trashedSnapshot = bggSnapshot("981024", "SQL 篩選測試：回收貢獻者", [], null, null, [designA, art, publisher]);
    const first = await store.createFromSource(firstSnapshot.ref, firstSnapshot);
    const second = await store.createFromSource(secondSnapshot.ref, secondSnapshot);
    const sameName = await store.createFromSource(sameNameSnapshot.ref, sameNameSnapshot);
    const trashed = await store.createFromSource(trashedSnapshot.ref, trashedSnapshot);
    const manual = await store.createManual("SQL 篩選測試：同名手動貢獻者", "board_game");
    const manualResult = await store.addManualContribution({ kind: "new", gameId: manual.id, name: designA.name, entityKind: "person", role: "design", allowDuplicate: true });
    if (manualResult.status !== "created") throw new Error("expected manual contributor fixture");
    await store.edit(first.game.id, { tags: ["SQL 篩選測試：貢獻者交集"] });
    await store.edit(second.game.id, { tags: ["SQL 篩選測試：貢獻者交集", "SQL 篩選測試：其他標籤"] });
    await store.trash(trashed.game.id);

    const firstContributions = (await store.get(first.game.id))?.contributors ?? [];
    const secondContributions = (await store.get(second.game.id))?.contributors ?? [];
    const contributorId = firstContributions.find((item) => item.role === "design")?.contributorId;
    const secondContributorId = secondContributions.find((item) => item.role === "design")?.contributorId;
    const artContributorId = firstContributions.find((item) => item.role === "art")?.contributorId;
    const publisherContributorId = firstContributions.find((item) => item.role === "publisher")?.contributorId;
    const distinctContributorId = (await store.get(sameName.game.id))?.contributors[0]?.contributorId;
    const manualContributorId = manualResult.game.contributors[0]?.contributorId;
    expect(contributorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondContributorId).not.toBe(contributorId);
    expect(distinctContributorId).not.toBe(contributorId);
    expect(manualContributorId).not.toBe(contributorId);
    await expect(runtimeDatabase.unsafe("select source_provider, source_contributor_id from app_private.contributors where id = $1", [manualContributorId])).resolves.toEqual([{ source_provider: null, source_contributor_id: null }]);
    await expect(library.listGames({ contributorIds: [contributorId ?? "missing"] })).resolves.toMatchObject([{ id: first.game.id }]);
    await expect(library.listGames({ contributorIds: [contributorId ?? "missing"], tags: ["SQL 篩選測試：貢獻者交集"] })).resolves.toMatchObject([{ id: first.game.id }]);
    await expect(library.listGames({ contributorIds: [distinctContributorId ?? "missing"] })).resolves.toMatchObject([{ id: sameName.game.id }]);
    await expect(library.listGames({ contributorIds: [manualContributorId ?? "missing"] })).resolves.toMatchObject([{ id: manual.id }]);
    await expect(library.listGames({
      search: "貢獻者",
      media: ["board_game"],
      tags: ["SQL 篩選測試：貢獻者交集"],
      sourceCategories: [{ kind: "category", sourceCategoryId: "sql-query-contributor-category" }],
      contributorRoles: [
        { role: "design", contributorIds: [contributorId ?? "missing", secondContributorId ?? "missing"] },
        { role: "art", contributorIds: [artContributorId ?? "missing"] },
        { role: "publisher", contributorIds: [publisherContributorId ?? "missing"] },
      ],
      weightMin: 2,
      weightMax: 4,
      sort: "strategy_rank",
    })).resolves.toMatchObject([{ id: second.game.id }, { id: first.game.id }]);
    await expect(library.listContributorFacets()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ contributorId, role: "design", name: designA.name }),
      expect.objectContaining({ contributorId: secondContributorId, role: "design", name: designB.name }),
      expect.objectContaining({ contributorId: artContributorId, role: "art", name: art.name }),
      expect.objectContaining({ contributorId: publisherContributorId, role: "publisher", name: publisher.name }),
    ]));
  });

  it("legacy snapshot 缺少來源關係時只在本地 contributor 身分可對應時提供可用篩選", async () => {
    const sourceContributor = { sourceContributorId: "sql-query-contributor-legacy", name: "SQL 篩選測試：Legacy 作者", entityKind: "person" as const, role: "design" as const };
    const snapshot = bggSnapshot("981025", "SQL 篩選測試：Legacy 貢獻者", [], null, null, [sourceContributor]);
    const created = await store.createFromSource(snapshot.ref, snapshot);
    const contributorId = created.game.contributors[0]?.contributorId;
    if (!contributorId) throw new Error("expected local source contributor id");
    await runtimeDatabase.unsafe("delete from app_private.source_contributions where identity_id = $1", [created.game.externalIdentityId]);

    await expect(store.get(created.game.id)).resolves.toMatchObject({ contributors: [{ contributorId }] });
    await expect(library.listGames({ contributorIds: [contributorId] })).resolves.toMatchObject([{ id: created.game.id }]);

    await runtimeDatabase.unsafe("delete from app_private.contributors where id = $1", [contributorId]);
    await expect(store.get(created.game.id)).resolves.toMatchObject({ contributors: [{ contributorId: null }] });
    await expect(library.listGames({ contributorIds: [contributorId] })).resolves.toEqual([]);
  });

  it("以日文來源名稱及別名部分搜尋，空白搜尋不增加條件", async () => {
    const snapshot: SourceSnapshot = {
      ...igdbSnapshot("981008"),
      title: "SQL 篩選測試：ゼルダの伝説",
      localizedTitle: null,
      aliases: ["ブレス オブ ザ ワイルド"],
    };
    const zelda = await store.createFromSource(snapshot.ref, snapshot);

    await expect(library.listGames({ search: "ゼルダ" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    await expect(library.listGames({ search: "ブレス オブ" })).resolves.toMatchObject([{ id: zelda.game.id }]);
    expect((await library.listGames({ search: "   " })).some((game) => game.id === zelda.game.id)).toBe(true);
  });

  it("一千款收藏中的部分名稱搜尋不超過一秒安全界線", async () => {
    await runtimeDatabase.unsafe(`
      insert into app_private.games (medium, display_name)
      select 'board_game', 'SQL 篩選測試：效能收藏 ' || lpad(value::text, 4, '0')
      from generate_series(1, 1000) as value
    `);
    await library.listGames({ search: "效能收藏 0999" });

    const startedAt = performance.now();
    const result = await library.listGames({ search: "效能收藏 0999" });
    const elapsedMs = performance.now() - startedAt;
    console.info(`library_search_1000_items_ms=${elapsedMs.toFixed(2)}`);

    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("SQL 篩選測試：效能收藏 0999");
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("回收區遊戲仍計入共享平台與標籤使用數，且刪除受關係約束", async () => {
    const game = await store.createManual("SQL 篩選測試：回收區共享項目", "video_game");
    await store.edit(game.id, { actualPlatforms: ["SQL 回收平台"], tags: ["SQL 回收標籤"] });
    await store.trash(game.id);

    expect(await store.listPlatforms()).toEqual(expect.arrayContaining([{ name: "SQL 回收平台", usageCount: 1, isSystem: false }]));
    expect(await store.listTags()).toEqual(expect.arrayContaining([{ name: "SQL 回收標籤", usageCount: 1, isSystem: false }]));
    await expect(library.deletePlatform("SQL 回收平台")).rejects.toThrow("仍有遊戲使用");
    await expect(library.deleteTag("SQL 回收標籤")).rejects.toThrow("仍有遊戲使用");
  });
});

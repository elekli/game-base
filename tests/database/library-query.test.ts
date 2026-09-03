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

function bggSnapshot(sourceId: string, title: string, categories: SourceSnapshot["categories"], weight: number | null, strategyRank: number | null): SourceSnapshot {
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
    contributors: [],
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

  it("回收區遊戲仍計入共享平台與標籤使用數，且刪除受關係約束", async () => {
    const game = await store.createManual("SQL 篩選測試：回收區共享項目", "video_game");
    await store.edit(game.id, { actualPlatforms: ["SQL 回收平台"], tags: ["SQL 回收標籤"] });
    await store.trash(game.id);

    expect(await store.listPlatforms()).toEqual(expect.arrayContaining([{ name: "SQL 回收平台", usageCount: 1, isSystem: false }]));
    expect(await store.listTags()).toEqual([{ name: "SQL 回收標籤", usageCount: 1, isSystem: false }]);
    await expect(library.deletePlatform("SQL 回收平台")).rejects.toThrow("仍有遊戲使用");
    await expect(library.deleteTag("SQL 回收標籤")).rejects.toThrow("仍有遊戲使用");
  });
});

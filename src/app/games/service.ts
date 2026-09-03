import "server-only";
import { BggCatalogAdapter, IgdbCatalogAdapter } from "@/adapters/sources";
import { TestCatalogAdapter, sampleFixture } from "@/adapters/sources/test-catalog-adapter";
import { createGamesService, InMemoryGameStore, UnavailableGameStore } from "@/modules/games";
import { createLibraryService } from "@/modules/library";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";

const bggFixture = sampleFixture("bgg", "1", "範例桌遊");
const bggLinkFixture = sampleFixture("bgg", "3", "連結範例桌遊");
const bggFilterAlphaFixture = { ...sampleFixture("bgg", "4", "篩選驗收合作"), categories: [{ kind: "category", sourceCategoryId: "filter-cooperative", name: "合作" }, { kind: "mechanic", sourceCategoryId: "filter-shared", name: "共用機制" }] as const, weight: 4.8, strategyRank: 88 };
const bggFilterBetaFixture = { ...sampleFixture("bgg", "5", "篩選驗收策略"), categories: [{ kind: "category", sourceCategoryId: "filter-strategy", name: "策略" }, { kind: "mechanic", sourceCategoryId: "filter-shared", name: "共用機制" }] as const, weight: 2.1, strategyRank: 12 };
const bggFilterGammaFixture = { ...sampleFixture("bgg", "6", "篩選驗收另一機制"), categories: [{ kind: "category", sourceCategoryId: "filter-cooperative", name: "合作" }, { kind: "mechanic", sourceCategoryId: "filter-other", name: "另一機制" }] as const, weight: 3.2, strategyRank: 30 };
const bggRefreshFixture = { ...sampleFixture("bgg", "7", "刷新驗收遊戲"), description: "A & B <script>alert(1)</script>" };
const igdbFixture = sampleFixture("igdb", "2", "範例電子遊戲");
const fixtureBgg = new TestCatalogAdapter("bgg", [bggFixture, bggLinkFixture, bggFilterAlphaFixture, bggFilterBetaFixture, bggFilterGammaFixture, bggRefreshFixture]);
const fixtureIgdb = new TestCatalogAdapter("igdb", [igdbFixture]);
fixtureBgg.setRefreshFailures("7", 1);

const forceFixtures = process.env.ALLOW_SOURCE_FIXTURES === "true";
const isDevelopment = process.env.VERCEL_ENV === "development";
const useFixtureStore = process.env.ALLOW_SOURCE_FIXTURES === "true" ||
  (process.env.VERCEL_ENV === "development" && !process.env.DATABASE_URL?.startsWith("postgres"));
const database = !useFixtureStore && process.env.DATABASE_URL?.startsWith("postgres") ? createDatabase(process.env.DATABASE_URL) : null;
function getFixtureStore() {
  const fixtureGlobal = globalThis as typeof globalThis & {
    __puizeruGamebaseFixtureStore?: InMemoryGameStore;
  };
  return fixtureGlobal.__puizeruGamebaseFixtureStore ??= new InMemoryGameStore();
}
const store = database ? new PostgresGameStore(database.db) : useFixtureStore ? getFixtureStore() : new UnavailableGameStore();

function createBggCatalog() {
  if (forceFixtures) return fixtureBgg;
  const token = process.env.BGG_TOKEN;
  if (token) return new BggCatalogAdapter({ token });
  return isDevelopment ? fixtureBgg : new BggCatalogAdapter();
}

function createIgdbCatalog() {
  if (forceFixtures) return fixtureIgdb;
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (clientId && clientSecret) return new IgdbCatalogAdapter({ clientId, clientSecret });
  return isDevelopment ? fixtureIgdb : new IgdbCatalogAdapter();
}

export const gamesService = createGamesService({
  bgg: createBggCatalog(),
  igdb: createIgdbCatalog(),
}, store);

export const libraryService = createLibraryService(store);

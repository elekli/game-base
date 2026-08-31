import "server-only";
import { BggCatalogAdapter, IgdbCatalogAdapter } from "@/adapters/sources";
import { TestCatalogAdapter, sampleFixture } from "@/adapters/sources/test-catalog-adapter";
import { createGamesService, InMemoryGameStore, UnavailableGameStore } from "@/modules/games";
import { createLibraryService } from "@/modules/library";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";

const bggFixture = sampleFixture("bgg", "1", "範例桌遊");
const igdbFixture = sampleFixture("igdb", "2", "範例電子遊戲");
const fixtureBgg = new TestCatalogAdapter("bgg", [bggFixture]);
const fixtureIgdb = new TestCatalogAdapter("igdb", [igdbFixture]);

const allowFixtures = process.env.VERCEL_ENV === "development" || process.env.ALLOW_SOURCE_FIXTURES === "true";
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

export const gamesService = createGamesService({
  bgg: process.env.BGG_TOKEN ? new BggCatalogAdapter({ token: process.env.BGG_TOKEN }) : allowFixtures ? fixtureBgg : new BggCatalogAdapter(),
  igdb: process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET ? new IgdbCatalogAdapter({ clientId: process.env.IGDB_CLIENT_ID, clientSecret: process.env.IGDB_CLIENT_SECRET }) : allowFixtures ? fixtureIgdb : new IgdbCatalogAdapter(),
}, store);

export const libraryService = createLibraryService(store);

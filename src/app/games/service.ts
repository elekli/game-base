import "server-only";
import { BggCatalogAdapter, IgdbCatalogAdapter } from "@/adapters/sources";
import { TestCatalogAdapter, sampleFixture } from "@/adapters/sources/test-catalog-adapter";
import { createGamesService, UnavailableGameStore } from "@/modules/games";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";

const bggFixture = sampleFixture("bgg", "1", "範例桌遊");
const igdbFixture = sampleFixture("igdb", "2", "範例電子遊戲");
const fixtureBgg = new TestCatalogAdapter("bgg", [bggFixture]);
const fixtureIgdb = new TestCatalogAdapter("igdb", [igdbFixture]);

const database = process.env.DATABASE_URL?.startsWith("postgres") ? createDatabase(process.env.DATABASE_URL) : null;
const allowFixtures = process.env.VERCEL_ENV === "development" || process.env.ALLOW_SOURCE_FIXTURES === "true";
const store = database ? new PostgresGameStore(database.db) : allowFixtures ? undefined : new UnavailableGameStore();

export const gamesService = createGamesService({
  bgg: process.env.BGG_TOKEN ? new BggCatalogAdapter({ token: process.env.BGG_TOKEN }) : allowFixtures ? fixtureBgg : new BggCatalogAdapter(),
  igdb: process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET ? new IgdbCatalogAdapter({ clientId: process.env.IGDB_CLIENT_ID, clientSecret: process.env.IGDB_CLIENT_SECRET }) : allowFixtures ? fixtureIgdb : new IgdbCatalogAdapter(),
}, store);

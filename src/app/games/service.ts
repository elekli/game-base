import "server-only";
import { BggCatalogAdapter, IgdbCatalogAdapter, TestCatalogAdapter, sampleFixture } from "@/adapters/sources";
import { createGamesService } from "@/modules/games";

const bggFixture = sampleFixture("bgg", "1", "範例桌遊");
const igdbFixture = sampleFixture("igdb", "2", "範例電子遊戲");
const fixtureBgg = new TestCatalogAdapter("bgg", [bggFixture]);
const fixtureIgdb = new TestCatalogAdapter("igdb", [igdbFixture]);

export const gamesService = createGamesService({
  bgg: process.env.BGG_TOKEN ? new BggCatalogAdapter({ token: process.env.BGG_TOKEN }) : fixtureBgg,
  igdb: process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET ? new IgdbCatalogAdapter({ clientId: process.env.IGDB_CLIENT_ID, clientSecret: process.env.IGDB_CLIENT_SECRET }) : fixtureIgdb,
});

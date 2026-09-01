import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";
import type { GameRecord, SourceSnapshot } from "@/modules/games";

const SOURCE_FAILURE_TRIGGER = "rollback_integration_source_failure";
const SOURCE_FAILURE_FUNCTION = "app_private.rollback_integration_source_failure";
const PLATFORM_FAILURE_TRIGGER = "rollback_integration_platform_failure";
const PLATFORM_FAILURE_FUNCTION = "app_private.rollback_integration_platform_failure";
const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;

if (!directDatabaseUrl) {
  throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");
}
const requiredDatabaseUrl: string = directDatabaseUrl;

type DatabaseRow = Readonly<Record<string, unknown>>;
type TestDatabase = ReturnType<typeof postgres>;

const postgresTestOptions = { max: 1, prepare: false, onnotice: () => undefined } as const;

let controlDatabase!: TestDatabase;
let runtimeDatabase!: TestDatabase;
let migrationDatabase!: TestDatabase;
let applicationDatabase!: ReturnType<typeof createDatabase>;
let store!: PostgresGameStore;

function databaseUrlForRole(role: "app_migrator" | "app_runtime"): string {
  const url = new URL(requiredDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function snapshotFor(
  sourceId: string,
  title: string,
  categoryId: string,
  contributorId: string,
  coverName: string,
  weight: number,
): SourceSnapshot {
  return {
    ref: { provider: "bgg", medium: "board_game", sourceId },
    canonicalUrl: `https://boardgamegeek.com/boardgame/${sourceId}`,
    title,
    localizedTitle: null,
    aliases: [`${title} 別名`],
    description: `${title} 來源介紹`,
    releaseYear: 2024,
    coverUrl: `https://cf.geekdo-images.com/${coverName}/original/img/test.jpg`,
    categories: [{ kind: "category", sourceCategoryId: categoryId, name: `${title} 分類` }],
    contributors: [{ sourceContributorId: contributorId, name: `${title} 設計者`, entityKind: "person", role: "design" }],
    minPlayers: 1,
    maxPlayers: 4,
    supportsSolo: "unsupported",
    playtimeMinutes: 60,
    weight,
    strategyRank: 12,
    supportedPlatforms: [],
  };
}

async function dropFailureInjection(): Promise<void> {
  await migrationDatabase.unsafe(`drop trigger if exists ${SOURCE_FAILURE_TRIGGER} on app_private.source_categories`);
  await migrationDatabase.unsafe(`drop function if exists ${SOURCE_FAILURE_FUNCTION}()`);
  await migrationDatabase.unsafe(`drop trigger if exists ${PLATFORM_FAILURE_TRIGGER} on app_private.game_platforms`);
  await migrationDatabase.unsafe(`drop function if exists ${PLATFORM_FAILURE_FUNCTION}()`);
}

async function cleanTestData(): Promise<void> {
  await runtimeDatabase.unsafe("delete from app_private.games where display_name like '交易回滾測試：%'");
  await runtimeDatabase.unsafe("delete from app_private.external_game_identities where provider = 'bgg' and source_id in ('980001', '980002')");
  await runtimeDatabase.unsafe("delete from app_private.source_categories where source_category_id like 'rollback-integration-%'");
  await runtimeDatabase.unsafe("delete from app_private.contributors where source_provider = 'bgg' and source_contributor_id like 'rollback-integration-%'");
  await runtimeDatabase.unsafe("delete from app_private.platforms where is_system = false and normalized_name like '交易回滾測試平台%'");
  await runtimeDatabase.unsafe("delete from app_private.tags where normalized_name like '交易回滾測試標籤%'");
}

async function installSourceFailure(): Promise<void> {
  await migrationDatabase.unsafe(`
    create or replace function ${SOURCE_FAILURE_FUNCTION}()
    returns trigger language plpgsql as $$
    begin
      raise exception 'rollback integration source failure';
    end;
    $$
  `);
  await migrationDatabase.unsafe(`
    create trigger ${SOURCE_FAILURE_TRIGGER}
    before insert on app_private.source_categories
    for each row execute function ${SOURCE_FAILURE_FUNCTION}()
  `);
}

async function installPlatformFailure(): Promise<void> {
  await migrationDatabase.unsafe(`
    create or replace function ${PLATFORM_FAILURE_FUNCTION}()
    returns trigger language plpgsql as $$
    begin
      raise exception 'rollback integration platform failure';
    end;
    $$
  `);
  await migrationDatabase.unsafe(`
    create trigger ${PLATFORM_FAILURE_TRIGGER}
    before insert on app_private.game_platforms
    for each row execute function ${PLATFORM_FAILURE_FUNCTION}()
  `);
}

async function expectDatabaseFailure(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  const messages: string[] = [];
  let current: unknown = caught;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages).toContain(expectedMessage);
}

async function readRollbackCounts(gameId: string, sourceId: string, categoryId: string, contributorId: string): Promise<DatabaseRow> {
  const rows = await runtimeDatabase.unsafe<DatabaseRow[]>(
    `
      select
        (select count(*)::int from app_private.external_game_identities where provider = 'bgg' and source_id = $1) as identity_count,
        (select count(*)::int from app_private.game_names where game_id = $2 and name_kind in ('source', 'alias')) as source_name_count,
        (select count(*)::int from app_private.source_categories where source_category_id = $3) as source_category_count,
        (select count(*)::int from app_private.source_contributions sc join app_private.external_game_identities i on i.id = sc.identity_id where i.provider = 'bgg' and i.source_id = $1 and sc.source_contributor_id = $4) as source_contribution_count,
        (select count(*)::int from app_private.media_ingests where game_id = $2) as cover_ingest_count
    `,
    [sourceId, gameId, categoryId, contributorId],
  );
  return rows[0];
}

async function readRefreshState(gameId: string, identityId: string): Promise<{
  game: GameRecord | null;
  snapshot: unknown;
  categories: readonly DatabaseRow[];
  contributions: readonly DatabaseRow[];
  playerProfiles: readonly DatabaseRow[];
  supportedPlatforms: readonly DatabaseRow[];
  coverIngests: readonly DatabaseRow[];
  metrics: readonly DatabaseRow[];
}> {
  const [snapshotRows, categories, contributions, playerProfiles, supportedPlatforms, coverIngests, metrics] = await Promise.all([
    runtimeDatabase.unsafe<DatabaseRow[]>("select snapshot from app_private.external_game_identities where id = $1", [identityId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select sc.provider, sc.category_kind, sc.source_category_id, sc.name from app_private.external_game_categories ec join app_private.source_categories sc on sc.id = ec.category_id where ec.identity_id = $1 order by sc.source_category_id", [identityId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select source_contributor_id, name, entity_kind, role from app_private.source_contributions where identity_id = $1 order by source_contributor_id, role", [identityId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select min_players, max_players, supports_solo from app_private.external_player_profiles where identity_id = $1", [identityId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select name from app_private.external_supported_platforms where identity_id = $1 order by normalized_name", [identityId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select source_url, object_key, original_state, thumbnail_state from app_private.media_ingests where game_id = $1 order by object_key", [gameId]),
    runtimeDatabase.unsafe<DatabaseRow[]>("select weight, strategy_rank, last_successful_sync_at from app_private.bgg_current_metrics where identity_id = $1", [identityId]),
  ]);
  return {
    game: await store.get(gameId),
    snapshot: snapshotRows[0]?.snapshot ?? null,
    categories,
    contributions,
    playerProfiles,
    supportedPlatforms,
    coverIngests,
    metrics,
  };
}

beforeAll(async () => {
  controlDatabase = postgres(requiredDatabaseUrl, postgresTestOptions);
  await controlDatabase.unsafe("grant app_migrator to postgres");
  await controlDatabase.unsafe("grant app_runtime to postgres");
  migrationDatabase = postgres(databaseUrlForRole("app_migrator"), postgresTestOptions);
  runtimeDatabase = postgres(databaseUrlForRole("app_runtime"), postgresTestOptions);
  applicationDatabase = createDatabase(databaseUrlForRole("app_runtime"));
  store = new PostgresGameStore(applicationDatabase.db);
  await runtimeDatabase.unsafe("select 1 from app_private.games limit 1");
});

beforeEach(async () => {
  await dropFailureInjection();
  await cleanTestData();
});

afterEach(async () => {
  await dropFailureInjection();
  await cleanTestData();
});

afterAll(async () => {
  await dropFailureInjection();
  await cleanTestData();
  await applicationDatabase.close();
  await migrationDatabase.end();
  await runtimeDatabase.end();
  await controlDatabase.unsafe("revoke app_runtime from postgres");
  await controlDatabase.unsafe("revoke app_migrator from postgres");
  await controlDatabase.end();
});

describe("PostgresGameStore 真實交易回滾", () => {
  it("link 中途失敗後不留下 identity、來源列、封面匯入或改動 owner data", async () => {
    const game = await store.createManual("交易回滾測試：手動連結", "board_game");
    const before = await store.edit(game.id, {
      displayName: "交易回滾測試：自訂手動條目",
      tags: ["交易回滾測試標籤：舊"],
      playerCountNote: "交易回滾測試：擁有者備註",
    });
    const snapshot = snapshotFor("980001", "交易回滾測試：來源連結", "rollback-integration-link-category", "rollback-integration-link-contributor", "rollback-link-cover", 3.2);

    await installSourceFailure();
    await expectDatabaseFailure(store.linkFromSource(game.id, snapshot.ref, snapshot), "rollback integration source failure");

    expect(await store.get(game.id)).toEqual(before);
    expect(await readRollbackCounts(game.id, snapshot.ref.sourceId, "rollback-integration-link-category", "rollback-integration-link-contributor")).toEqual({
      identity_count: 0,
      source_name_count: 0,
      source_category_count: 0,
      source_contribution_count: 0,
      cover_ingest_count: 0,
    });
  });

  it("refresh 中途失敗後保留舊 snapshot、來源關係、封面匯入、BGG 最後成功時間與 owner data", async () => {
    const oldSnapshot = snapshotFor("980002", "交易回滾測試：舊來源", "rollback-integration-refresh-old-category", "rollback-integration-refresh-old-contributor", "rollback-refresh-old-cover", 3.2);
    const newSnapshot = snapshotFor("980002", "交易回滾測試：新來源", "rollback-integration-refresh-new-category", "rollback-integration-refresh-new-contributor", "rollback-refresh-new-cover", 4.1);
    const created = await store.createFromSource(oldSnapshot.ref, oldSnapshot);
    const before = await store.edit(created.game.id, {
      displayName: "交易回滾測試：自訂重新整理",
      tags: ["交易回滾測試標籤：重新整理舊"],
      playerCountNote: "交易回滾測試：重新整理 owner 備註",
    });
    const identityId = before.externalIdentityId;
    if (!identityId) throw new Error("refresh fixture did not create an external identity");
    const stateBefore = await readRefreshState(before.id, identityId);

    await installSourceFailure();
    await expectDatabaseFailure(store.refreshSource(before.id, newSnapshot), "rollback integration source failure");

    const stateAfter = await readRefreshState(before.id, identityId);
    expect(stateAfter).toEqual(stateBefore);
  });

  it("edit 中途失敗後不留下半套 platforms 或 tags", async () => {
    const game = await store.createManual("交易回滾測試：編輯", "video_game");
    const before = await store.edit(game.id, {
      actualPlatforms: ["Steam"],
      tags: ["交易回滾測試標籤：編輯舊"],
      playerCountNote: "交易回滾測試：編輯舊備註",
    });

    await installPlatformFailure();
    await expectDatabaseFailure(store.edit(game.id, {
      actualPlatforms: ["交易回滾測試平台：一", "交易回滾測試平台：二"],
      tags: ["交易回滾測試標籤：編輯新"],
      playerCountNote: "交易回滾測試：編輯新備註",
    }), "rollback integration platform failure");

    expect(await store.get(game.id)).toEqual(before);
  });
});

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;
if (!directDatabaseUrl) throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");
const requiredDatabaseUrl: string = directDatabaseUrl;

const postgresTestOptions = { max: 1, prepare: false, onnotice: () => undefined } as const;
const testPrefix = "contributor-reuse-test:";
type TestDatabase = ReturnType<typeof postgres>;

let controlDatabase!: TestDatabase;
let runtimeDatabase!: TestDatabase;
let applicationDatabase!: ReturnType<typeof createDatabase>;
let store!: PostgresGameStore;

function databaseUrlForRole(role: "app_migrator" | "app_runtime"): string {
  const url = new URL(requiredDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

async function cleanTestData(): Promise<void> {
  await runtimeDatabase.unsafe("delete from app_private.games where display_name like 'contributor-reuse-test:%'");
  await runtimeDatabase.unsafe("delete from app_private.contributors where source_provider is null and name like 'contributor-reuse-test:%'");
}

async function counts(name: string): Promise<{ contributors: number; relationships: number }> {
  const rows = await runtimeDatabase.unsafe<{ contributors: number; relationships: number }[]>(
    `select
      (select count(*)::int from app_private.contributors where lower(btrim(name)) = lower(btrim($1))) as contributors,
      (select count(*)::int from app_private.manual_contributions mc join app_private.contributors c on c.id = mc.contributor_id where lower(btrim(c.name)) = lower(btrim($1))) as relationships`,
    [name],
  );
  return rows[0];
}

beforeAll(async () => {
  controlDatabase = postgres(requiredDatabaseUrl, postgresTestOptions);
  await controlDatabase.unsafe("grant app_migrator to postgres");
  await controlDatabase.unsafe("grant app_runtime to postgres");
  runtimeDatabase = postgres(databaseUrlForRole("app_runtime"), postgresTestOptions);
  applicationDatabase = createDatabase(databaseUrlForRole("app_runtime"));
  store = new PostgresGameStore(applicationDatabase.db);
});

beforeEach(cleanTestData);
afterEach(cleanTestData);

afterAll(async () => {
  await cleanTestData();
  await applicationDatabase.close();
  await runtimeDatabase.end();
  await controlDatabase.unsafe("revoke app_runtime from postgres");
  await controlDatabase.unsafe("revoke app_migrator from postgres");
  await controlDatabase.end();
});

describe("PostgresGameStore contributor 重用", () => {
  it("同名未確認在 transaction 內回傳 confirmation_required，且零新增", async () => {
    const game = await store.createManual(`${testPrefix}確認`, "board_game");
    const first = await store.addManualContribution({ kind: "new", gameId: game.id, name: `${testPrefix}同名`, entityKind: "person", role: "design", allowDuplicate: false });
    if (first.status !== "created") throw new Error("fixture contributor was not created");
    const before = await counts(`${testPrefix}同名`);

    const result = await store.addManualContribution({ kind: "new", gameId: game.id, name: `  ${testPrefix}同名  `, entityKind: "person", role: "art", allowDuplicate: false });

    expect(result).toMatchObject({ status: "confirmation_required", matches: [{ contributorId: first.game.contributors[0].contributorId, rolesOnGame: ["design"] }] });
    expect(await counts(`${testPrefix}同名`)).toEqual(before);
  });

  it("existing contributor 可在同一遊戲建立不同 role", async () => {
    const game = await store.createManual(`${testPrefix}重用`, "board_game");
    const first = await store.addManualContribution({ kind: "new", gameId: game.id, name: `${testPrefix}重用`, entityKind: "person", role: "design", allowDuplicate: false });
    if (first.status !== "created") throw new Error("fixture contributor was not created");
    const contributorId = first.game.contributors[0].contributorId;

    const reused = await store.addManualContribution({ kind: "existing", gameId: game.id, contributorId, role: "art" });

    expect(reused.status).toBe("created");
    if (reused.status !== "created") throw new Error("existing contributor was not reused");
    expect(reused.game.contributors.filter((item) => item.origin === "manual").map((item) => [item.contributorId, item.role]).sort((left, right) => left[1].localeCompare(right[1]))).toEqual([[contributorId, "art"], [contributorId, "design"]]);
  });

  it("allowDuplicate 會建立不同 contributor 實體", async () => {
    const game = await store.createManual(`${testPrefix}同名建立`, "board_game");
    const first = await store.addManualContribution({ kind: "new", gameId: game.id, name: `${testPrefix}允許同名`, entityKind: "person", role: "design", allowDuplicate: false });
    if (first.status !== "created") throw new Error("fixture contributor was not created");

    const duplicate = await store.addManualContribution({ kind: "new", gameId: game.id, name: ` ${testPrefix}允許同名 `, entityKind: "person", role: "art", allowDuplicate: true });

    expect(duplicate.status).toBe("created");
    if (duplicate.status !== "created") throw new Error("duplicate contributor was not created");
    const contributorIds = duplicate.game.contributors.filter((item) => item.origin === "manual").map((item) => item.contributorId);
    expect(contributorIds).toHaveLength(2);
    expect(contributorIds[1]).not.toBe(first.game.contributors[0].contributorId);
    expect(await counts(`${testPrefix}允許同名`)).toEqual({ contributors: 2, relationships: 2 });
  });
});

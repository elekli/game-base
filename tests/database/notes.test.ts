import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDatabase } from "@/adapters/database";
import { PostgresNoteStore } from "@/adapters/postgres-note-store";
import { CommandIdempotencyConflictError } from "@/modules/commands";
import { NoteGameUnavailableError, NoteVersionConflictError } from "@/modules/notes";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const url = new URL(directDatabaseUrl);
url.searchParams.set("options", "-c role=app_runtime");
const database = createDatabase(url.toString());
const store = new PostgresNoteStore(database.db);
const ownerId = "owner-subject";
let gameId: string;

beforeAll(async () => {
  const admin = postgres(directDatabaseUrl, { max: 1 });
  await admin.unsafe("grant app_runtime to postgres");
  await admin.end();
});

beforeEach(async () => {
  gameId = crypto.randomUUID();
  await database.db.execute(sql`insert into app_private.games (id, medium, display_name) values (${gameId}, 'board_game', '筆記測試')`);
});

afterAll(async () => database.close());

describe("PostgresNoteStore", () => {
  it("建立回應遺失後重送只回放同一 note，且不同 payload 衝突", async () => {
    const commandId = crypto.randomUUID();
    const command = { ownerId, commandId, gameId, content: "  第一則 **Markdown**  " };

    const first = await store.create(command);
    const replay = await store.create(command);

    expect(replay).toEqual({ ...first, replayed: true });
    expect(await store.list(gameId)).toHaveLength(1);
    await expect(store.create({ ...command, content: "另一則" })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
  });

  it("兩個 stale writer 恰一成功，失敗者取得伺服器目前內容", async () => {
    const created = await store.create({ ownerId, commandId: crypto.randomUUID(), gameId, content: "初始" });
    const first = store.update({ ownerId, commandId: crypto.randomUUID(), noteId: created.resourceId, expectedVersion: 1, content: "分頁甲" });
    const second = store.update({ ownerId, commandId: crypto.randomUUID(), noteId: created.resourceId, expectedVersion: 1, content: "分頁乙" });

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(NoteVersionConflictError);
    expect((rejected?.reason as NoteVersionConflictError).current.content).toMatch(/分頁[甲乙]/);
  });

  it("remove／restore 保留原文與 id 並單調增加版本", async () => {
    const created = await store.create({ ownerId, commandId: crypto.randomUUID(), gameId, content: "不能遺失" });
    const removed = await store.remove({ ownerId, commandId: crypto.randomUUID(), noteId: created.resourceId, expectedVersion: 1 });
    expect(removed).toMatchObject({ resourceId: created.resourceId, version: 2, state: "removed" });
    expect(await store.list(gameId)).toEqual([]);

    const restored = await store.restore({ ownerId, commandId: crypto.randomUUID(), noteId: created.resourceId, expectedVersion: 2 });
    expect(restored).toMatchObject({ resourceId: created.resourceId, version: 3, state: "active" });
    expect(await store.list(gameId)).toEqual([expect.objectContaining({ id: created.resourceId, content: "不能遺失", version: 3 })]);
  });

  it("資源回收中的 game 不接受建立筆記", async () => {
    await database.db.execute(sql`update app_private.games set trashed_at = clock_timestamp() where id = ${gameId}`);
    await expect(store.create({ ownerId, commandId: crypto.randomUUID(), gameId, content: "不應建立" }))
      .rejects.toBeInstanceOf(NoteGameUnavailableError);
  });
});

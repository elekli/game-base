import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDatabase } from "@/adapters/database";
import { PostgresListStore } from "@/adapters/postgres-list-store";
import { PostgresGameStore } from "@/adapters/database-game-store";
import { PostgresExternalThumbnailStore } from "@/adapters/postgres-external-thumbnail-store";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "@/modules/commands";
import { ListMemberConflictError, ListNameInUseError, ListReferenceInvalidError, createListsService } from "@/modules/lists";
import type { SourceSnapshot } from "@/modules/games/internal/types";

const directUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const url = new URL(directUrl);
url.searchParams.set("options", "-c role=app_runtime");
const db = createDatabase(url.toString());
const store = new PostgresListStore(db.db);
const service = createListsService(store);
const games = new PostgresGameStore(db.db);
const thumbnails = new PostgresExternalThumbnailStore(db.db);
const ownerId = "list-test-owner";
const key = () => crypto.randomUUID();
const command = () => ({ ownerId, commandId: key() });

async function cleanTestData() {
  await db.db.execute(sql`delete from app_private.list_command_receipts where owner_id = ${ownerId}`);
  await db.db.execute(sql`delete from app_private.list_memberships where list_id in (select id from app_private.lists where name like '清單-%')`);
  await db.db.execute(sql`delete from app_private.lists where name like '清單-%'`);
  await db.db.execute(sql`delete from app_private.games where display_name like '遊戲-%' or display_name = '庫外桌遊'`);
  await db.db.execute(sql`delete from app_private.external_game_references where name in ('庫外桌遊', '舊名稱', '新名稱')`);
  await db.db.execute(sql`delete from app_private.external_game_identities where snapshot ->> 'title' in ('庫外桌遊', '舊名稱', '新名稱')`);
}

beforeAll(async () => {
  const admin = postgres(directUrl, { max: 1 });
  await admin.unsafe("grant app_runtime to postgres");
  await admin.end();
  await cleanTestData();
});
afterEach(cleanTestData);
afterAll(async () => { await cleanTestData(); await db.close(); });

describe("PostgresListStore", () => {
  it("第一成員與清單原子建立，失敗不留空清單或收據", async () => {
    const name = `清單-${key()}`;
    const failed = { ...command(), name, firstMember: { kind: "game" as const, gameId: key() } };
    await expect(service.create(failed)).rejects.toBeInstanceOf(ListReferenceInvalidError);
    expect(await service.findName(name)).toBeNull();
    const receipts = await db.db.execute(sql`select command_id from app_private.list_command_receipts where command_id = ${failed.commandId}`) as unknown[];
    expect(receipts).toHaveLength(0);

    const game = await games.createManual(`遊戲-${key()}`, "board_game");
    const created = await service.create({ ...command(), name: `  ${name}  `, firstMember: { kind: "game", gameId: game.id } });
    expect(created).toMatchObject({ version: 1, state: "active", replayed: false });
    expect((await service.get(created.resourceId))?.members).toHaveLength(1);
    await expect(service.create({ ...command(), name: name.toUpperCase(), firstMember: { kind: "game", gameId: game.id } })).rejects.toBeInstanceOf(ListNameInUseError);
  });

  it("同一命令只回放結果，不同內容與過期版本拒絕", async () => {
    const game = await games.createManual(`遊戲-${key()}`, "board_game");
    const input = { ...command(), name: `清單-${key()}`, firstMember: { kind: "game" as const, gameId: game.id } };
    const created = await service.create(input);
    expect(await service.create(input)).toEqual({ ...created, replayed: true });
    await expect(service.create({ ...input, name: `${input.name}變更` })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
    const archived = await service.archive({ ...command(), listId: created.resourceId, expectedVersion: 1 });
    expect(archived).toMatchObject({ version: 2, state: "archived" });
    await expect(service.restore({ ...command(), listId: created.resourceId, expectedVersion: 1 })).rejects.toBeInstanceOf(CommandVersionConflictError);
    expect((await service.findName(input.name))?.archived).toBe(true);
    expect((await service.restore({ ...command(), listId: created.resourceId, expectedVersion: 2 })).state).toBe("active");
  });

  it("來源名稱或年份更新後仍可回放同一庫外命令", async () => {
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 2_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const input = { ...command(), name: `清單-${key()}`, firstMember: { kind: "external" as const, ref, name: "舊名稱", releaseYear: 1995 } };
    const created = await service.create(input);
    await expect(service.create({ ...input, firstMember: { ...input.firstMember, name: "新名稱", releaseYear: 1996 } }))
      .resolves.toEqual({ ...created, replayed: true });
  });

  it("封存清單可由仍在清單中的庫內遊戲找回", async () => {
    const game = await games.createManual(`遊戲-${key()}`, "board_game");
    const created = await service.create({ ...command(), name: `清單-${key()}`, firstMember: { kind: "game", gameId: game.id } });
    await service.archive({ ...command(), listId: created.resourceId, expectedVersion: 1 });
    await expect(service.archivedForGame(game.id)).resolves.toEqual([
      expect.objectContaining({ id: created.resourceId, archived: true, memberCount: 1 }),
    ]);
  });

  it("庫外身分轉為正式遊戲時，成員 ID 與外部引用不搬移", async () => {
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const created = await service.create({ ...command(), name: `清單-${key()}`, firstMember: { kind: "external", ref, name: "庫外桌遊", releaseYear: 2020 } });
    const before = (await service.get(created.resourceId))!.members[0];
    expect(before).toMatchObject({ resolvedGameId: null, target: { kind: "external", ref } });
    const snapshot: SourceSnapshot = { ref, canonicalUrl: `https://boardgamegeek.com/boardgame/${sourceId}`, title: "庫外桌遊", localizedTitle: null, aliases: [], description: null, releaseYear: 2020, coverUrl: null, categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] };
    const promoted = await games.createFromSource(ref, snapshot);
    const after = (await service.get(created.resourceId))!.members[0];
    expect(after.id).toBe(before.id);
    expect(after.target).toEqual({ kind: "game", gameId: promoted.game.id });
    expect(after.resolvedGameId).toBe(promoted.game.id);
  });

  it("來源型收藏遊戲維持庫內成員名稱，重建來源時回傳既有遊戲", async () => {
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 4_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const snapshot: SourceSnapshot = { ref, canonicalUrl: `https://boardgamegeek.com/boardgame/${sourceId}`, title: "庫外桌遊", localizedTitle: null, aliases: [], description: null, releaseYear: 2020, coverUrl: null, categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] };
    const first = await games.createFromSource(ref, snapshot);
    const second = await games.createFromSource(ref, snapshot);
    expect(second).toMatchObject({ game: { id: first.game.id }, created: false });

    const created = await service.create({ ...command(), name: `清單-${key()}`, firstMember: { kind: "game", gameId: first.game.id } });
    expect((await service.get(created.resourceId))!.members[0]).toMatchObject({
      target: { kind: "game", gameId: first.game.id },
      resolvedGameId: first.game.id,
    });
  });

  it("庫外封面縮圖以租約從 pending 收斂到 failed 或 ready", async () => {
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const created = await service.create({ ...command(), name: `清單-${key()}`, firstMember: { kind: "external", ref, name: "庫外桌遊", releaseYear: 2020 } });
    const first = await thumbnails.claim(ref, { token: key(), until: new Date(Date.now() + 60_000).toISOString() });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected thumbnail claim");
    await thumbnails.fail(first.identityId, first.leaseToken);
    expect((await service.get(created.resourceId))!.members[0]).toMatchObject({ thumbnailState: "failed", thumbnailUrl: null });

    const second = await thumbnails.claim(ref, { token: key(), until: new Date(Date.now() + 60_000).toISOString() });
    if (second.status !== "claimed") throw new Error("expected retry claim");
    const objectKey = `external-reference-thumbnails/${second.identityId}/${"a".repeat(64)}.webp`;
    await expect(thumbnails.complete(second.identityId, second.leaseToken, objectKey)).resolves.toBe(true);
    expect((await service.get(created.resourceId))!.members[0]).toMatchObject({ thumbnailState: "ready", thumbnailUrl: null });
    let signingAttempts = 0;
    const recoveringReadService = createListsService(new PostgresListStore(db.db, async () => {
      signingAttempts += 1;
      if (signingAttempts === 1) throw new Error("signing unavailable");
      return "https://storage.example.test/signed-thumbnail";
    }));
    expect((await recoveringReadService.get(created.resourceId))!.members[0]).toMatchObject({ thumbnailState: "failed", thumbnailUrl: null });
    expect((await recoveringReadService.get(created.resourceId))!.members[0]).toMatchObject({ thumbnailState: "ready", thumbnailUrl: "https://storage.example.test/signed-thumbnail" });
  });

  it("成員去重涵蓋軟移除與解析後遊戲", async () => {
    const game = await games.createManual(`遊戲-${key()}`, "board_game");
    const created = await service.create({ ...command(), name: `清單-${key()}`, firstMember: { kind: "game", gameId: game.id } });
    await expect(service.add({ ...command(), listId: created.resourceId, expectedVersion: 1, member: { kind: "game", gameId: game.id } })).rejects.toBeInstanceOf(ListMemberConflictError);
    const member = (await service.get(created.resourceId))!.members[0];
    await service.removeMember({ ...command(), memberId: member.id, expectedVersion: 1 });
    await expect(service.add({ ...command(), listId: created.resourceId, expectedVersion: 2, member: { kind: "game", gameId: game.id } })).rejects.toMatchObject({ restorable: true });
  });
});

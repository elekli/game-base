import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";
import { PostgresListStore } from "@/adapters/postgres-list-store";
import { PostgresRelationStore } from "@/adapters/postgres-relation-store";
import { RelationConflictError, RelationInvalidError, createRelationsService } from "@/modules/relations";
import { ListMemberConflictError, createListsService } from "@/modules/lists";
import { SourceLinkReferenceConflictError, type ExternalGameRef, type SourceSnapshot } from "@/modules/games";

const directUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const url = new URL(directUrl); url.searchParams.set("options", "-c role=app_runtime");
const db = createDatabase(url.toString());
const games = new PostgresGameStore(db.db);
const relations = createRelationsService(new PostgresRelationStore(db.db));
const lists = createListsService(new PostgresListStore(db.db));
const ownerId = "relation-test-owner";
const key = () => crypto.randomUUID();
const command = () => ({ ownerId, commandId: key() });

function snapshot(ref: ExternalGameRef): SourceSnapshot {
  return {
    ref,
    canonicalUrl: ref.provider === "bgg" ? `https://boardgamegeek.com/boardgame/${ref.sourceId}` : `https://www.igdb.com/games/${ref.sourceId}`,
    title: `關聯-${ref.sourceId}`, localizedTitle: null, aliases: [], description: null, releaseYear: 2020, coverUrl: null,
    categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null,
    weight: null, strategyRank: null, supportedPlatforms: [],
  };
}

async function cleanTestData() {
  await db.db.execute(sql`delete from app_private.relation_command_receipts where owner_id = ${ownerId}`);
  await db.db.execute(sql`delete from app_private.game_relations where left_game_id in (select id from app_private.games where display_name like '關聯-%') or right_game_id in (select id from app_private.games where display_name like '關聯-%') or left_external_game_identity_id in (select id from app_private.external_game_identities where snapshot->>'title' like '關聯-%') or right_external_game_identity_id in (select id from app_private.external_game_identities where snapshot->>'title' like '關聯-%')`);
  await db.db.execute(sql`delete from app_private.list_command_receipts where owner_id = ${ownerId}`);
  await db.db.execute(sql`delete from app_private.list_memberships where list_id in (select id from app_private.lists where name like '關聯清單-%')`);
  await db.db.execute(sql`delete from app_private.lists where name like '關聯清單-%'`);
  await db.db.execute(sql`delete from app_private.games where display_name like '關聯-%'`);
  await db.db.execute(sql`delete from app_private.external_game_references where external_game_identity_id in (select id from app_private.external_game_identities where snapshot->>'title' like '關聯-%')`);
  await db.db.execute(sql`delete from app_private.external_game_identities where snapshot->>'title' like '關聯-%'`);
}

beforeAll(async () => {
  const admin = postgres(directUrl, { max: 1 });
  await admin.unsafe("grant app_runtime to postgres");
  await admin.end();
  await cleanTestData();
});
afterEach(cleanTestData);
afterAll(async () => { await cleanTestData(); await db.close(); });

describe("PostgresRelationStore", () => {
  it("新增、解除與還原關聯都更新兩端遊戲聚合版本", async () => {
    const left = await games.createManual(`關聯-${key()}`, "board_game");
    const right = await games.createManual(`關聯-${key()}`, "video_game");

    const relation = await relations.add({ ...command(), left: { kind: "game", gameId: left.id }, right: { kind: "game", gameId: right.id } });
    expect((await games.get(left.id))?.version).toBe(left.version + 1);
    expect((await games.get(right.id))?.version).toBe(right.version + 1);

    await relations.remove({ ...command(), relationId: relation.resourceId, expectedVersion: relation.version });
    expect((await games.get(left.id))?.version).toBe(left.version + 2);
    expect((await games.get(right.id))?.version).toBe(right.version + 2);

    await relations.restore({ ...command(), relationId: relation.resourceId, expectedVersion: relation.version + 1 });
    expect((await games.get(left.id))?.version).toBe(left.version + 3);
    expect((await games.get(right.id))?.version).toBe(right.version + 3);
  });

  it("相反方向同時新增只保留一筆，兩個遊戲都讀到同一關聯", async () => {
    const left = await games.createManual(`關聯-${key()}`, "board_game");
    const right = await games.createManual(`關聯-${key()}`, "video_game");
    const results = await Promise.allSettled([
      relations.add({ ...command(), left: { kind: "game", gameId: left.id }, right: { kind: "game", gameId: right.id } }),
      relations.add({ ...command(), left: { kind: "game", gameId: right.id }, right: { kind: "game", gameId: left.id } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(RelationConflictError);
    const [leftRelations, rightRelations] = await Promise.all([relations.forGame(left.id), relations.forGame(right.id)]);
    expect(leftRelations).toHaveLength(1);
    expect(rightRelations.map((relation) => relation.id)).toEqual([leftRelations[0]?.id]);
  });

  it("庫外來源轉正後保留 membership 與 relation 列，不搬移資料", async () => {
    const game = await games.createManual(`關聯-${key()}`, "board_game");
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const target = { kind: "external" as const, ref, name: `關聯-${sourceId}`, releaseYear: 2020 };
    const list = await lists.create({ ...command(), name: `關聯清單-${key()}`, firstMember: target });
    const membershipBefore = (await lists.get(list.resourceId))!.members[0]!;
    const relation = await relations.add({ ...command(), left: { kind: "game", gameId: game.id }, right: target });
    const externalReference = (await db.db.execute(sql`select name, release_year from app_private.external_game_references where external_game_identity_id = (select id from app_private.external_game_identities where provider = ${ref.provider} and source_id = ${ref.sourceId})`) as Record<string, unknown>[])[0];
    expect(externalReference).toEqual({ name: `關聯-${sourceId}`, release_year: 2020 });
    const beforePromotion = (await relations.forGame(game.id)).find((item) => item.id === relation.resourceId);
    expect([beforePromotion?.left, beforePromotion?.right].find((target) => target?.kind === "external")).toMatchObject({ releaseYear: 2020 });
    const relationBefore = (await db.db.execute(sql`select id, left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id, version from app_private.game_relations where id = ${relation.resourceId}`) as Record<string, unknown>[])[0];

    const promoted = await games.createFromSource(ref, snapshot(ref));
    const membershipAfter = (await lists.get(list.resourceId))!.members[0]!;
    const relationAfter = (await db.db.execute(sql`select id, left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id, version from app_private.game_relations where id = ${relation.resourceId}`) as Record<string, unknown>[])[0];
    expect(membershipAfter.id).toBe(membershipBefore.id);
    expect(membershipAfter.resolvedGameId).toBe(promoted.game.id);
    expect(relationAfter).toEqual(relationBefore);
    const promotedRelations = await relations.forGame(promoted.game.id);
    expect(promotedRelations.map((item) => item.id)).toContain(relation.resourceId);
  });

  it("來源連結折疊清單成員時整筆拒絕並保留原遊戲與兩筆 membership", async () => {
    const game = await games.createManual(`關聯-${key()}`, "board_game");
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 4_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const listName = `關聯清單-${key()}`;
    const list = await lists.create({ ...command(), name: listName, firstMember: { kind: "game", gameId: game.id } });
    await lists.add({ ...command(), listId: list.resourceId, expectedVersion: 1, member: { kind: "external", ref, name: `關聯-${sourceId}`, releaseYear: 2020 } });
    await expect(games.linkFromSource(game.id, ref, snapshot(ref))).rejects.toMatchObject({
      lists: [{ id: list.resourceId, name: listName }],
      relations: [],
    });
    expect((await games.get(game.id))?.externalIdentityId).toBeNull();
    expect((await lists.get(list.resourceId))?.members).toHaveLength(2);
    const removedMembership = (await db.db.execute(sql`select id, version from app_private.list_memberships where list_id = ${list.resourceId} and external_game_identity_id = (select id from app_private.external_game_identities where provider = 'bgg' and source_id = ${sourceId})`) as Record<string, unknown>[])[0];
    await lists.removeMember({ ...command(), memberId: String(removedMembership?.id), expectedVersion: Number(removedMembership?.version) });
    await games.linkFromSource(game.id, ref, snapshot(ref));
    await expect(lists.restoreMember({ ...command(), memberId: String(removedMembership?.id), expectedVersion: Number(removedMembership?.version) + 1 })).rejects.toBeInstanceOf(ListMemberConflictError);
  });

  it("來源連結若會形成自我或重複關聯即回滾", async () => {
    const game = await games.createManual(`關聯-${key()}`, "board_game");
    const other = await games.createManual(`關聯-${key()}`, "video_game");
    const sourceId = String(Math.floor(Math.random() * 1_000_000_000) + 5_000_000_000);
    const ref = { provider: "bgg" as const, sourceId, medium: "board_game" as const };
    const external = { kind: "external" as const, ref, name: `關聯-${sourceId}`, releaseYear: 2020 };
    const first = await relations.add({ ...command(), left: { kind: "game", gameId: game.id }, right: external });
    const directPair = await relations.add({ ...command(), left: { kind: "game", gameId: game.id }, right: { kind: "game", gameId: other.id } });
    const duplicatePair = await relations.add({ ...command(), left: external, right: { kind: "game", gameId: other.id } });
    await expect(games.linkFromSource(game.id, ref, snapshot(ref))).rejects.toMatchObject({
      lists: [],
      relations: expect.arrayContaining([
        expect.objectContaining({ id: first.resourceId, otherGameId: game.id }),
      ]),
    });
    expect((await games.get(game.id))?.externalIdentityId).toBeNull();
    expect(await relations.forGame(game.id)).toHaveLength(2);
    expect((await db.db.execute(sql`select count(*)::int as count from app_private.game_relations where id in (${first.resourceId}, ${directPair.resourceId}, ${duplicatePair.resourceId})`) as Record<string, unknown>[])[0]?.count).toBe(3);
    expect((await db.db.execute(sql`select id from app_private.game_relations where id = ${first.resourceId}`) as unknown[])).toHaveLength(1);
    await relations.remove({ ...command(), relationId: first.resourceId, expectedVersion: first.version });
    await relations.remove({ ...command(), relationId: duplicatePair.resourceId, expectedVersion: duplicatePair.version });
    await games.linkFromSource(game.id, ref, snapshot(ref));
    await expect(relations.restore({ ...command(), relationId: first.resourceId, expectedVersion: first.version + 1 })).rejects.toBeInstanceOf(RelationInvalidError);
    await expect(relations.restore({ ...command(), relationId: duplicatePair.resourceId, expectedVersion: duplicatePair.version + 1 })).rejects.toBeInstanceOf(RelationConflictError);
    expect((await games.get(game.id))?.externalIdentityId).not.toBeNull();
    expect(directPair.resourceId).not.toBe(duplicatePair.resourceId);
  });

  it("兩筆不同來源連結並行時共用碰撞鎖，只允許第一筆通過", async () => {
    const left = await games.createManual("關聯-競態-left-" + key(), "board_game");
    const right = await games.createManual("關聯-競態-right-" + key(), "board_game");
    const firstRef = { provider: "bgg" as const, sourceId: String(Math.floor(Math.random() * 1_000_000_000) + 6_000_000_000), medium: "board_game" as const };
    const secondRef = { provider: "bgg" as const, sourceId: String(Math.floor(Math.random() * 1_000_000_000) + 7_000_000_000), medium: "board_game" as const };
    const gamePair = await relations.add({ ...command(), left: { kind: "game", gameId: left.id }, right: { kind: "game", gameId: right.id } });
    const externalPair = await relations.add({ ...command(), left: { kind: "external", ref: firstRef, name: "關聯-" + firstRef.sourceId, releaseYear: 2020 }, right: { kind: "external", ref: secondRef, name: "關聯-" + secondRef.sourceId, releaseYear: 2020 } });
    const admin = postgres(directUrl, { max: 1 });
    await admin.unsafe("grant app_migrator to postgres");
    await admin.unsafe("set role app_migrator");
    await admin.unsafe("create or replace function app_private.pause_relation_link_test() returns trigger language plpgsql as $$ begin perform pg_sleep(0.5); return new; end $$");
    await admin.unsafe("create trigger pause_relation_link_test before update of external_game_identity_id on app_private.games for each row when (new.external_game_identity_id is not null) execute function app_private.pause_relation_link_test()");
    try {
      const results = await Promise.allSettled([
        games.linkFromSource(left.id, firstRef, snapshot(firstRef)),
        games.linkFromSource(right.id, secondRef, snapshot(secondRef)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(SourceLinkReferenceConflictError);
      const count = await admin`select count(*)::int as count from app_private.game_relations where id in (${gamePair.resourceId}, ${externalPair.resourceId})`;
      expect(Number(count[0]?.count)).toBe(2);
    } finally {
      await admin.unsafe("drop trigger if exists pause_relation_link_test on app_private.games");
      await admin.unsafe("drop function if exists app_private.pause_relation_link_test()");
      await admin.unsafe("reset role");
      await admin.end();
    }
  });
});

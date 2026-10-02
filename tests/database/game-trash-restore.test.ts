import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";
import { PostgresListStore } from "@/adapters/postgres-list-store";
import { PostgresMediaStore } from "@/adapters/postgres-media-store";
import { PostgresNoteStore } from "@/adapters/postgres-note-store";
import { PostgresRelationStore } from "@/adapters/postgres-relation-store";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "@/modules/commands";
import { createListsService, ListStateConflictError } from "@/modules/lists";
import { type BeginMediaUploadResult, type FinalizeMediaUploadResult } from "@/modules/media";
import { createMediaService } from "@/modules/media/internal/create-media-service";
import type { MediaObjectStore } from "@/modules/media/internal/types";
import { createNotesService } from "@/modules/notes";
import { createRelationsService, RelationStateConflictError } from "@/modules/relations";
import { SourceGameUnavailableError } from "@/modules/games";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const ownerId = "game-trash-restore-test-owner";
const owner = { sub: ownerId };
const options = { max: 1, prepare: false, onnotice: () => undefined } as const;
type Row = Readonly<Record<string, unknown>>;
type TestMedia = ReturnType<typeof createMediaService>;

function roleUrl(role: "app_runtime" | "app_migrator", applicationName?: string): string {
  const url = new URL(directDatabaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  if (applicationName) url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function dropReceiptFailure() {
  await migrator.unsafe("drop trigger if exists game_trash_receipt_failure on app_private.command_receipts");
  await migrator.unsafe("drop function if exists app_private.game_trash_receipt_failure()");
}

async function clean() {
  await dropReceiptFailure();
  await control.unsafe("alter table app_private.media_derivative_attempts disable trigger user");
  await control.unsafe("alter table app_private.media_derivatives disable trigger user");
  await control.unsafe("alter table app_private.media_assets disable trigger user");
  await control.unsafe("alter table app_private.media_ingests disable trigger user");
  const ids = await runtime.unsafe<{ id: string }[]>("select id from app_private.games where display_name like '資源回收整合測試%'");
  const gameIds = ids.map(({ id }) => id);
  if (gameIds.length) {
    await control.unsafe("delete from app_private.game_relations where left_game_id = any($1::uuid[]) or right_game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.list_memberships where game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.notes where game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.manual_contributions where game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.media_derivatives where asset_id in (select id from app_private.media_assets where game_id = any($1::uuid[]))", [gameIds]);
    await control.unsafe("delete from app_private.media_assets where game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.media_ingest_operations where ingest_id in (select id from app_private.media_ingests where game_id = any($1::uuid[]))", [gameIds]);
    await control.unsafe("delete from app_private.media_ingests where game_id = any($1::uuid[])", [gameIds]);
    await control.unsafe("delete from app_private.command_receipts where owner_id = $1 and target_id = any($2::uuid[])", [ownerId, gameIds]);
    await control.unsafe("delete from app_private.games where id = any($1::uuid[])", [gameIds]);
  }
  await control.unsafe("delete from app_private.list_command_receipts where owner_id = $1", [ownerId]);
  await control.unsafe("delete from app_private.relation_command_receipts where owner_id = $1", [ownerId]);
  await control.unsafe("delete from app_private.lists where name like '資源回收整合測試清單：%'");
  await control.unsafe("alter table app_private.media_ingests enable trigger user");
  await control.unsafe("alter table app_private.media_assets enable trigger user");
  await control.unsafe("alter table app_private.media_derivatives enable trigger user");
  await control.unsafe("alter table app_private.media_derivative_attempts enable trigger user");
}

function mediaObjects(bytes: Uint8Array) {
  const writes = { uploadGrant: 0, derivative: 0, deletes: 0 };
  const reads: string[] = [];
  const objects: MediaObjectStore = {
    async createUploadGrant(path) { writes.uploadGrant += 1; return { uploadUrl: `https://storage.example.test/${encodeURIComponent(path)}`, token: `token:${path}`, expiresAt: "2026-10-02T01:00:00.000Z" }; },
    async createOriginalReadGrant(path) { return { url: `https://storage.example.test/${encodeURIComponent(path)}`, expiresAt: "2026-10-02T01:01:00.000Z" }; },
    async inspect(path) { return { path, byteSize: bytes.byteLength, mimeType: "image/png" }; },
    async *read(path) { reads.push(path); yield bytes; },
    async uploadDerivative() { writes.derivative += 1; },
    async deleteDerivative() { writes.deletes += 1; },
  };
  return { objects, writes, reads };
}

function uploadGrant(result: BeginMediaUploadResult) {
  if (result.status !== "upload_grant") throw new Error("expected media upload grant");
  return result;
}

function finalized(result: FinalizeMediaUploadResult) {
  if ("status" in result) throw new Error("expected finalized media upload");
  return result;
}

let control!: ReturnType<typeof postgres>;
let runtime!: ReturnType<typeof postgres>;
let migrator!: ReturnType<typeof postgres>;
let database!: ReturnType<typeof createDatabase>;
let games!: PostgresGameStore;
let notes!: ReturnType<typeof createNotesService>;
let lists!: ReturnType<typeof createListsService>;
let relations!: ReturnType<typeof createRelationsService>;

beforeAll(async () => {
  control = postgres(directDatabaseUrl, options);
  await control.unsafe("grant app_runtime to postgres");
  await control.unsafe("grant app_migrator to postgres");
  runtime = postgres(roleUrl("app_runtime"), { ...options, max: 5 });
  migrator = postgres(roleUrl("app_migrator"), options);
  database = createDatabase(roleUrl("app_runtime"));
  games = new PostgresGameStore(database.db);
  notes = createNotesService(new PostgresNoteStore(database.db));
  lists = createListsService(new PostgresListStore(database.db));
  relations = createRelationsService(new PostgresRelationStore(database.db));
  await clean();
});

afterEach(clean);

afterAll(async () => {
  await clean();
  await database.close();
  await runtime.end();
  await migrator.end();
  await control.unsafe("revoke app_runtime from postgres");
  await control.unsafe("revoke app_migrator from postgres");
  await control.end();
});

async function aggregateSnapshot(gameId: string) {
  const [game, names, tags, platforms, contributions, noteRows, assets, derivatives, memberships, relationRows] = await Promise.all([
    runtime.unsafe<Row[]>("select to_jsonb(g) - 'trashed_at' - 'version' as value from app_private.games g where id = $1", [gameId]),
    runtime.unsafe("select id, name, name_kind from app_private.game_names where game_id = $1 order by id", [gameId]),
    runtime.unsafe("select gt.tag_id, t.name from app_private.game_tags gt join app_private.tags t on t.id = gt.tag_id where gt.game_id = $1 order by gt.tag_id", [gameId]),
    runtime.unsafe("select gp.platform_id, p.name from app_private.game_platforms gp join app_private.platforms p on p.id = gp.platform_id where gp.game_id = $1 order by gp.platform_id", [gameId]),
    runtime.unsafe("select id, contributor_id, role from app_private.manual_contributions where game_id = $1 order by id", [gameId]),
    runtime.unsafe("select id, content, version, removed_at from app_private.notes where game_id = $1 order by id", [gameId]),
    runtime.unsafe("select id, purpose, original_object_path, original_file_name, actual_mime_type, byte_size, removed_at, caption, display_name, description from app_private.media_assets where game_id = $1 order by id", [gameId]),
    runtime.unsafe("select d.id, d.asset_id, d.kind, d.state, d.object_key from app_private.media_derivatives d join app_private.media_assets a on a.id = d.asset_id where a.game_id = $1 order by d.id", [gameId]),
    runtime.unsafe("select id, list_id, game_id, external_game_identity_id, description, version, removed_at from app_private.list_memberships where game_id = $1 order by id", [gameId]),
    runtime.unsafe("select id, left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id, description, version, removed_at from app_private.game_relations where left_game_id = $1 or right_game_id = $1 order by id", [gameId]),
  ]);
  return { game: game[0]?.value, names, tags, platforms, contributions, notes: noteRows, assets, derivatives, memberships, relations: relationRows };
}

describe("Postgres game trash／restore", () => {
  it("只改資源回收標記與版本，完整保留聚合資料與 Storage 物件", async () => {
    const imageBytes = new Uint8Array(await sharp({ create: { width: 12, height: 16, channels: 3, background: "#34a853" } }).png().toBuffer());
    const storage = mediaObjects(imageBytes);
    const media: TestMedia = createMediaService({ store: new PostgresMediaStore(database.db), objects: storage.objects });
    const game = await games.createManual("資源回收整合測試：聚合", "board_game");
    await games.editWithCommand({ ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 1, payload: { displayName: "資源回收整合測試：完整保留", tags: ["資源回收整合測試標籤"], playerCountNote: "手動說明" } });
    const contribution = await games.addManualContribution({ kind: "new", gameId: game.id, name: "資源回收整合測試設計師", entityKind: "person", role: "design", allowDuplicate: true });
    expect(contribution.status).toBe("created");
    await notes.create({ ownerId, commandId: randomUUID(), gameId: game.id, content: "資源回收後仍保留的筆記" });
    const list = await lists.create({ ownerId, commandId: randomUUID(), name: `資源回收整合測試清單：${randomUUID()}`, firstMember: { kind: "game", gameId: game.id } });
    const listMember = (await lists.get(list.resourceId))?.members.find((member) => member.resolvedGameId === game.id);
    if (!listMember) throw new Error("test list membership disappeared");
    await lists.describeMember({ ownerId, commandId: randomUUID(), memberId: listMember.id, expectedVersion: listMember.version, description: "資源回收前既有清單說明" });
    const peer = await games.createManual("資源回收整合測試：關聯", "video_game");
    const relation = await relations.add({ ownerId, commandId: randomUUID(), left: { kind: "game", gameId: game.id }, right: { kind: "game", gameId: peer.id } });
    await relations.describe({ ownerId, commandId: randomUUID(), relationId: relation.resourceId, expectedVersion: relation.version, description: "資源回收前既有關聯說明" });
    const upload = uploadGrant(await media.beginMediaUpload(owner, { idempotencyKey: randomUUID(), gameId: game.id, purpose: "gallery_image", originalFileName: "kept.png", declaredMimeType: "image/png", declaredByteSize: imageBytes.byteLength }));
    const mediaResult = finalized(await media.finalizeMediaUpload(owner, { idempotencyKey: (await runtime.unsafe<{ idempotency_key: string }[]>("select idempotency_key from app_private.media_ingests where id = $1", [upload.ingestId]))[0]!.idempotency_key }));
    const before = await aggregateSnapshot(game.id);
    const storageHash = createHash("sha256").update(Buffer.from(imageBytes)).digest("hex");
    const beforeWrites = { ...storage.writes };
    const beforeReads = [...storage.reads];
    const current = await games.get(game.id);
    if (!current) throw new Error("test game disappeared");

    const trashed = await games.moveToTrashWithCommand({ ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: current.version });
    expect(trashed).toMatchObject({ state: "trashed", version: current.version + 1, replayed: false });
    expect(await aggregateSnapshot(game.id)).toEqual(before);
    expect(await games.list()).not.toContainEqual(expect.objectContaining({ id: game.id }));
    expect(await games.listTrashed()).toContainEqual(expect.objectContaining({ id: game.id, version: current.version + 1 }));
    expect(await notes.list(game.id)).toEqual([]);
    expect((await lists.get(list.resourceId))?.members).toContainEqual(expect.objectContaining({ resolvedGameId: game.id, trashed: true }));
    const trashedRelation = (await relations.forGame(game.id)).find((item) => item.id === relation.resourceId);
    expect(trashedRelation).toBeDefined();
    expect(
      trashedRelation?.leftGameId === game.id && trashedRelation.leftTrashed
      || trashedRelation?.rightGameId === game.id && trashedRelation.rightTrashed,
    ).toBe(true);
    expect(await games.getTrashConfirmation(game.id)).toMatchObject({ counts: { notes: 1, photos: 1, attachments: 0, lists: 1, relations: 1 } });
    await expect(games.edit(game.id, { displayName: "不可寫入" })).rejects.toBeInstanceOf(SourceGameUnavailableError);
    await expect(relations.describe({ ownerId, commandId: randomUUID(), relationId: relation.resourceId, expectedVersion: 2, description: "不可寫入" })).rejects.toBeInstanceOf(RelationStateConflictError);
    await expect(lists.describeMember({ ownerId, commandId: randomUUID(), memberId: listMember.id, expectedVersion: listMember.version + 1, description: "不可寫入" })).rejects.toBeInstanceOf(ListStateConflictError);

    const restored = await games.restoreWithCommand({ ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: trashed.version });
    expect(restored).toMatchObject({ state: "active", version: current.version + 2, replayed: false });
    expect(await aggregateSnapshot(game.id)).toEqual(before);
    const read = await media.issueOriginalRead(owner, { assetId: mediaResult.asset.id });
    expect(read.status).toBe("original_read");
    const [{ original_object_path: originalPath }] = await runtime.unsafe<{ original_object_path: string }[]>("select original_object_path from app_private.media_assets where id = $1", [mediaResult.asset.id]);
    const restoredChunks: Uint8Array[] = [];
    for await (const chunk of storage.objects.read(originalPath!)) restoredChunks.push(chunk);
    expect(storage.reads).toEqual([...beforeReads, originalPath]);
    expect(createHash("sha256").update(Buffer.concat(restoredChunks)).digest("hex")).toBe(storageHash);
    expect(storage.writes).toEqual(beforeWrites);
  });

  it("並行舊版命令只允許一方成功，同命令重送只增加一次版本", async () => {
    const game = await games.createManual("資源回收整合測試：命令並行", "board_game");
    const same = { ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 1 } as const;
    const replayed = await Promise.all([games.moveToTrashWithCommand(same), games.moveToTrashWithCommand(same)]);
    expect(replayed).toEqual(expect.arrayContaining([
      { resourceId: game.id, version: 2, state: "trashed", replayed: false },
      { resourceId: game.id, version: 2, state: "trashed", replayed: true },
    ]));

    await games.restoreWithCommand({ ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 2 });
    const stale = ["甲", "乙"].map(() => games.moveToTrashWithCommand({ ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 3 }));
    const outcomes = await Promise.allSettled(stale);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected" && result.reason instanceof CommandVersionConflictError)).toHaveLength(1);
    await expect(games.moveToTrashWithCommand({ ...same, expectedVersion: 9 })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
  });

  it("收據完成失敗會回滾狀態與版本，原命令可安全重試", async () => {
    const game = await games.createManual("資源回收整合測試：交易回滾", "board_game");
    const command = { ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 1 } as const;
    await migrator.unsafe(`
      create function app_private.game_trash_receipt_failure()
      returns trigger language plpgsql as $$
      begin
        if new.owner_id = '${ownerId}' and new.command_kind in ('game.trash', 'game.restore') and new.result_version is not null then
          raise exception 'game trash receipt completion failure';
        end if;
        return new;
      end;
      $$
    `);
    await migrator.unsafe("create trigger game_trash_receipt_failure before update of result_version on app_private.command_receipts for each row execute function app_private.game_trash_receipt_failure()");

    await expect(games.moveToTrashWithCommand(command)).rejects.toThrow();
    await expect(games.get(game.id)).resolves.toMatchObject({ trashedAt: null, version: 1 });
    await expect(runtime.unsafe("select count(*)::int as count from app_private.command_receipts where command_id = $1", [command.commandId])).resolves.toEqual([{ count: 0 }]);

    await dropReceiptFailure();
    await expect(games.moveToTrashWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "trashed", replayed: false });
  });

  it("先取得遊戲列鎖的移入命令會讓後續手動貢獻新增完整拒絕", async () => {
    const game = await games.createManual("資源回收整合測試：寫入競態", "board_game");
    const seededContributor = await games.addManualContribution({ kind: "new", gameId: game.id, name: "資源回收整合測試既有作者", entityKind: "person", role: "design", allowDuplicate: true });
    if (seededContributor.status !== "created") throw new Error("expected test contribution");
    const command = { ownerId, commandId: randomUUID(), gameId: game.id, expectedVersion: 1 } as const;
    const trigger = "game_trash_lock_delay";
    const applicationName = "game_trash_contributor_race";
    const competingDb = createDatabase(roleUrl("app_runtime", applicationName));
    const competingGames = new PostgresGameStore(competingDb.db);
    await migrator.unsafe(`
      create function app_private.${trigger}()
      returns trigger language plpgsql as $$
      begin
        if new.trashed_at is not null and old.trashed_at is null then perform pg_sleep(0.2); end if;
        return new;
      end;
      $$
    `);
    await migrator.unsafe(`create trigger ${trigger} before update of trashed_at on app_private.games for each row execute function app_private.${trigger}()`);
    try {
      const moving = games.moveToTrashWithCommand(command);
      const adding = competingGames.addManualContribution({ kind: "new", gameId: game.id, name: "不應留下的競態作者", entityKind: "person", role: "art", allowDuplicate: true });
      const [moveResult, addResult] = await Promise.allSettled([moving, adding]);
      expect(moveResult.status).toBe("fulfilled");
      expect(addResult.status).toBe("rejected");
      if (addResult.status === "rejected") expect(addResult.reason).toBeInstanceOf(SourceGameUnavailableError);
      await expect(runtime.unsafe("select count(*)::int as count from app_private.contributors where source_provider is null and name = $1", ["不應留下的競態作者"])).resolves.toEqual([{ count: 0 }]);
    } finally {
      await migrator.unsafe(`drop trigger if exists ${trigger} on app_private.games`);
      await migrator.unsafe(`drop function if exists app_private.${trigger}()`);
      await competingDb.close();
    }
  });
});

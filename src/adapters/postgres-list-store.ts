import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { referenceKey } from "./reference-key";
import { CommandIdempotencyConflictError, CommandTargetNotFoundError, CommandVersionConflictError, commandPayloadSha256 } from "@/modules/commands";
import type { ExternalGameRef } from "@/modules/games/internal/types";
import { ListMemberConflictError, ListNameInUseError, ListReferenceInvalidError, ListStateConflictError, listTargetCommandBinding, type AddListMemberCommand, type CreateListCommand, type ListCommand, type ListMember, type ListRecord, type ListResult, type ListStore, type ListTarget, type MemberCommand } from "@/modules/lists";
import type { ProductionExecutor, QueryExecutor } from "./database-game-store";

type Row = Readonly<Record<string, unknown>>;
type Kind = "list.create" | "list.add" | "list.archive" | "list.restore" | "list.member.remove" | "list.member.restore" | "list.member.describe";
type Binding = Readonly<{ ownerId: string; commandId: string; kind: Kind; targetId: string | null; expectedVersion: number | null; payload: unknown }>;
const listFields = sql`id, name, version, archived_at`;
function asList(row: Row): ListRecord { return { id: String(row.id), name: String(row.name), version: Number(row.version), archived: row.archived_at !== null, memberCount: Number(row.member_count ?? 0) }; }
function asResult(row: Row, replayed = false): ListResult { return { resourceId: String(row.id), version: Number(row.version), state: row.removed_at !== undefined ? row.removed_at === null ? "active" : "removed" : row.archived_at === null ? "active" : "archived", replayed }; }
function asExternalTarget(row: Row): ListTarget {
  const provider = row.provider;
  const medium = row.medium;
  if ((provider !== "bgg" && provider !== "igdb") || (medium !== "board_game" && medium !== "video_game") || (provider === "bgg" && medium !== "board_game") || (provider === "igdb" && medium !== "video_game") || typeof row.external_name !== "string") throw new ListReferenceInvalidError();
  const ref: ExternalGameRef = provider === "bgg"
    ? { provider, sourceId: String(row.source_id), medium: "board_game" }
    : { provider, sourceId: String(row.source_id), medium: "video_game" };
  return { kind: "external", ref, name: row.external_name, releaseYear: row.release_year === null ? null : Number(row.release_year) };
}

export class PostgresListStore implements ListStore {
  constructor(private readonly db: ProductionExecutor, private readonly issueThumbnailRead?: (objectKey: string) => Promise<string>) {}

  async list(): Promise<readonly ListRecord[]> {
    const rows = await this.db.execute(sql`select l.id, l.name, l.version, l.archived_at, count(m.id) filter (where m.removed_at is null) as member_count from app_private.lists l left join app_private.list_memberships m on m.list_id = l.id where l.archived_at is null group by l.id order by lower(l.name), l.id`) as Row[];
    return rows.map(asList);
  }

  async archivedForGame(gameId: string): Promise<readonly ListRecord[]> {
    const rows = await this.db.execute(sql`
      select l.id, l.name, l.version, l.archived_at,
             count(distinct all_members.id) filter (where all_members.removed_at is null) as member_count
      from app_private.lists l
      join app_private.list_memberships member on member.list_id = l.id and member.removed_at is null
      left join app_private.list_memberships all_members on all_members.list_id = l.id
      where l.archived_at is not null and (
        member.game_id = ${gameId}
        or member.external_game_identity_id = (select external_game_identity_id from app_private.games where id = ${gameId})
      )
      group by l.id
      order by lower(l.name), l.id
    `) as Row[];
    return rows.map(asList);
  }

  async findName(name: string): Promise<ListRecord | null> {
    const rows = await this.db.execute(sql`select l.id, l.name, l.version, l.archived_at, count(m.id) filter (where m.removed_at is null) as member_count from app_private.lists l left join app_private.list_memberships m on m.list_id = l.id where l.name_key = lower(${name.trim()}) collate "C" group by l.id`) as Row[];
    return rows[0] ? asList(rows[0]) : null;
  }

  async get(listId: string): Promise<{ list: ListRecord; members: readonly ListMember[] } | null> {
    const lists = await this.db.execute(sql`select l.id, l.name, l.version, l.archived_at, count(m.id) filter (where m.removed_at is null) as member_count from app_private.lists l left join app_private.list_memberships m on m.list_id = l.id where l.id = ${listId} group by l.id`) as Row[];
    if (!lists[0]) return null;
    const rows = await this.db.execute(sql`
      select m.*, coalesce(g.id, owned.id) as resolved_game_id, coalesce(g.trashed_at, owned.trashed_at) as game_trashed_at,
             i.provider, i.source_id, i.medium, coalesce(r.name, g.display_name) as external_name, r.release_year,
             r.thumbnail_object_key, r.thumbnail_state
      from app_private.list_memberships m
      left join app_private.external_game_identities i on i.id = m.external_game_identity_id
      left join app_private.external_game_references r on r.external_game_identity_id = i.id
      left join app_private.games g on g.external_game_identity_id = i.id
      left join app_private.games owned on owned.id = m.game_id
      where m.list_id = ${listId}
      order by lower(coalesce(g.display_name, owned.display_name, r.name)), m.id
    `) as Row[];
    const members = await Promise.all(rows.map(async (row): Promise<ListMember> => {
      const resolvedGameId = row.resolved_game_id === null ? null : String(row.resolved_game_id);
      let thumbnailState: ListMember["thumbnailState"] = resolvedGameId === null && (row.thumbnail_state === "pending" || row.thumbnail_state === "ready" || row.thumbnail_state === "failed") ? row.thumbnail_state : "missing";
      let thumbnailUrl: string | null = null;
      if (thumbnailState === "ready" && row.thumbnail_object_key && this.issueThumbnailRead) {
        try { thumbnailUrl = await this.issueThumbnailRead(String(row.thumbnail_object_key)); }
        catch { thumbnailState = "failed"; }
      }
      return {
        id: String(row.id), listId: String(row.list_id),
        target: resolvedGameId ? { kind: "game", gameId: resolvedGameId } : asExternalTarget(row),
        resolvedGameId, trashed: row.game_trashed_at !== null, description: row.description === null ? null : String(row.description), version: Number(row.version), removed: row.removed_at !== null,
        thumbnailState, thumbnailUrl,
      };
    }));
    return { list: asList(lists[0]), members };
  }

  create(command: CreateListCommand): Promise<ListResult> {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind: "list.create", targetId: null, expectedVersion: null, payload: { name: command.name, firstMember: listTargetCommandBinding(command.firstMember) } }, async (tx) => {
      const clash = await tx.execute(sql`select l.id, l.name, l.version, l.archived_at, count(m.id) filter (where m.removed_at is null) as member_count from app_private.lists l left join app_private.list_memberships m on m.list_id = l.id where l.name_key = lower(${command.name}) collate "C" group by l.id`) as Row[];
      if (clash[0]) throw new ListNameInUseError(asList(clash[0]));
      const id = randomUUID();
      const inserted = await tx.execute(sql`insert into app_private.lists(id, name) values (${id}, ${command.name}) on conflict (name_key) do nothing returning ${listFields}`) as Row[];
      if (!inserted[0]) {
        const rows = await tx.execute(sql`select l.id, l.name, l.version, l.archived_at, count(m.id) filter (where m.removed_at is null) as member_count from app_private.lists l left join app_private.list_memberships m on m.list_id = l.id where l.name_key = lower(${command.name}) collate "C" group by l.id`) as Row[];
        if (rows[0]) throw new ListNameInUseError(asList(rows[0]));
        throw new CommandTargetNotFoundError();
      }
      await this.insertMember(tx, id, command.firstMember);
      return asResult(inserted[0]);
    });
  }

  add(command: AddListMemberCommand): Promise<ListResult> {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind: "list.add", targetId: command.listId, expectedVersion: command.expectedVersion, payload: { member: listTargetCommandBinding(command.member) } }, async (tx) => {
      const list = await this.lockList(tx, command.listId, command.expectedVersion, true);
      await this.insertMember(tx, list.id, command.member);
      const rows = await tx.execute(sql`update app_private.lists set version = version + 1, updated_at = clock_timestamp() where id = ${list.id} returning ${listFields}`) as Row[];
      return asResult(rows[0]!);
    });
  }

  archive(command: ListCommand): Promise<ListResult> { return this.changeList(command, "list.archive", true); }
  restore(command: ListCommand): Promise<ListResult> { return this.changeList(command, "list.restore", false); }
  private changeList(command: ListCommand, kind: "list.archive" | "list.restore", archived: boolean): Promise<ListResult> {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind, targetId: command.listId, expectedVersion: command.expectedVersion, payload: {} }, async (tx) => {
      const current = await this.lockList(tx, command.listId, command.expectedVersion, false);
      if (current.archived === archived) throw new ListStateConflictError();
      const rows = await tx.execute(sql`update app_private.lists set archived_at = ${archived ? sql`clock_timestamp()` : sql`null`}, version = version + 1, updated_at = clock_timestamp() where id = ${current.id} returning ${listFields}`) as Row[];
      return asResult(rows[0]!);
    });
  }

  removeMember(command: MemberCommand): Promise<ListResult> { return this.changeMember(command, "list.member.remove"); }
  restoreMember(command: MemberCommand): Promise<ListResult> { return this.changeMember(command, "list.member.restore"); }
  describeMember(command: MemberCommand & { description: string | null }): Promise<ListResult> { return this.changeMember(command, "list.member.describe", command.description); }
  private changeMember(command: MemberCommand, kind: "list.member.remove" | "list.member.restore" | "list.member.describe", description?: string | null): Promise<ListResult> {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind, targetId: command.memberId, expectedVersion: command.expectedVersion, payload: kind === "list.member.describe" ? { description } : {} }, async (tx) => {
      const parent = await tx.execute(sql`select list_id from app_private.list_memberships where id = ${command.memberId}`) as Row[];
      if (!parent[0]) throw new CommandTargetNotFoundError();
      await this.lockList(tx, String(parent[0].list_id), null, true);
      const rows = await tx.execute(sql`select * from app_private.list_memberships where id = ${command.memberId} for update`) as Row[];
      if (!rows[0]) throw new CommandTargetNotFoundError();
      const member = rows[0];
      if (Number(member.version) !== command.expectedVersion) throw new CommandVersionConflictError(Number(member.version), member.removed_at === null ? "active" : "removed");
      if (kind === "list.member.remove" && member.removed_at !== null || kind === "list.member.restore" && member.removed_at === null || kind === "list.member.describe" && member.removed_at !== null) throw new ListStateConflictError();
      if (kind === "list.member.describe") {
        const games = await tx.execute(sql`
          select id, trashed_at from app_private.games
          where id = ${member.game_id} or external_game_identity_id = ${member.external_game_identity_id}
          order by id for update
        `) as Row[];
        if (games.some((game) => game.trashed_at !== null)) throw new ListStateConflictError();
      }
      if (kind === "list.member.restore") {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('source-link-reference-collision', 0))`);
        const targetRows = await tx.execute(sql`
          select m.list_id,
            ${referenceKey(sql`m.external_game_identity_id`, sql`g.external_game_identity_id`, sql`m.game_id`)} as reference_key
          from app_private.list_memberships m left join app_private.games g on g.id = m.game_id
          where m.id = ${command.memberId}
        `) as Row[];
        const target = targetRows[0];
        if (!target) throw new CommandTargetNotFoundError();
        const conflicts = await tx.execute(sql`
          select m.id from app_private.list_memberships m left join app_private.games g on g.id = m.game_id
          where m.list_id = ${target.list_id} and m.id <> ${command.memberId} and m.removed_at is null
            and ${referenceKey(sql`m.external_game_identity_id`, sql`g.external_game_identity_id`, sql`m.game_id`)} = ${target.reference_key}
          limit 1
        `) as Row[];
        if (conflicts[0]) throw new ListMemberConflictError(false);
      }
      const updated = await tx.execute(sql`update app_private.list_memberships set removed_at = ${kind === "list.member.remove" ? sql`clock_timestamp()` : kind === "list.member.restore" ? sql`null` : sql`removed_at`}, description = ${kind === "list.member.describe" ? description ?? null : sql`description`}, version = version + 1, updated_at = clock_timestamp() where id = ${command.memberId} returning id, version, removed_at`) as Row[];
      if (kind !== "list.member.describe") await tx.execute(sql`update app_private.lists set version = version + 1, updated_at = clock_timestamp() where id = ${String(member.list_id)}`);
      return asResult(updated[0]!);
    });
  }

  private async lockList(tx: QueryExecutor, id: string, expectedVersion: number | null, active: boolean): Promise<ListRecord> {
    const rows = await tx.execute(sql`select ${listFields} from app_private.lists where id = ${id} for update`) as Row[];
    if (!rows[0]) throw new CommandTargetNotFoundError();
    const current = asList(rows[0]);
    if (expectedVersion !== null && current.version !== expectedVersion) throw new CommandVersionConflictError(current.version, current.archived ? "removed" : "active");
    if (active && current.archived) throw new ListStateConflictError();
    return current;
  }

  private async insertMember(tx: QueryExecutor, listId: string, target: ListTarget): Promise<void> {
    let gameId: string | null = null;
    let identityId: string | null = null;
    if (target.kind === "game") {
      const games = await tx.execute(sql`select id, external_game_identity_id, trashed_at from app_private.games where id = ${target.gameId} for update`) as Row[];
      if (!games[0] || games[0].trashed_at !== null) throw new ListReferenceInvalidError();
      gameId = target.gameId;
    } else {
      const { ref, name, releaseYear } = target;
      if (!/^(0|[1-9][0-9]*)$/.test(ref.sourceId) || !name.trim() || (ref.provider === "bgg" && ref.medium !== "board_game") || (ref.provider === "igdb" && ref.medium !== "video_game")) throw new ListReferenceInvalidError();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'source:' + ref.provider + ':' + ref.sourceId}, 0))`);
      const identity = await tx.execute(sql`insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify({ ref, title: name.trim(), releaseYear })}::jsonb) on conflict (provider, source_id) do update set provider = excluded.provider returning id, medium`) as Row[];
      if (!identity[0] || identity[0].medium !== ref.medium) throw new ListReferenceInvalidError();
      identityId = String(identity[0].id);
      await tx.execute(sql`insert into app_private.external_game_references (external_game_identity_id, name, release_year) values (${identityId}, ${name.trim()}, ${releaseYear}) on conflict (external_game_identity_id) do nothing`);
    }
    const existing = await tx.execute(sql`
      select m.id, m.removed_at from app_private.list_memberships m
      left join app_private.games g on g.id = m.game_id
      where m.list_id = ${listId} and
        ((${identityId}::uuid is not null and (m.external_game_identity_id = ${identityId}::uuid or g.external_game_identity_id = ${identityId}::uuid))
         or (${gameId}::uuid is not null and (m.game_id = ${gameId}::uuid or m.external_game_identity_id = (select external_game_identity_id from app_private.games where id = ${gameId}::uuid))))
      for update of m
    `) as Row[];
    if (existing[0]) throw new ListMemberConflictError(existing[0].removed_at !== null);
    const inserted = await tx.execute(sql`insert into app_private.list_memberships (id, list_id, game_id, external_game_identity_id) values (${randomUUID()}, ${listId}, ${gameId}, ${identityId}) on conflict do nothing returning id`) as Row[];
    if (!inserted[0]) throw new ListMemberConflictError(false);
  }

  private async execute(binding: Binding, mutation: (tx: QueryExecutor) => Promise<ListResult>): Promise<ListResult> {
    const digest = commandPayloadSha256(binding.payload);
    return this.db.transaction(async (tx) => {
      let rows = await tx.execute(sql`insert into app_private.list_command_receipts(command_id, owner_id, command_kind, target_id, expected_version, payload_sha256) values (${binding.commandId}, ${binding.ownerId}, ${binding.kind}, ${binding.targetId}, ${binding.expectedVersion}, ${digest}) on conflict (command_id) do nothing returning *`) as Row[];
      let claimed = rows.length > 0;
      let receipt = rows[0];
      if (!receipt) { rows = await tx.execute(sql`select * from app_private.list_command_receipts where command_id = ${binding.commandId} for update`) as Row[]; receipt = rows[0]; }
      if (!receipt) throw new CommandTargetNotFoundError();
      if (!claimed && receipt.result_version !== null) {
        const expiry = await tx.execute(sql`select expires_at <= clock_timestamp() as expired from app_private.list_command_receipts where command_id = ${binding.commandId}`) as Row[];
        if (expiry[0]?.expired === true) {
          await tx.execute(sql`delete from app_private.list_command_receipts where command_id = ${binding.commandId}`);
          rows = await tx.execute(sql`insert into app_private.list_command_receipts(command_id, owner_id, command_kind, target_id, expected_version, payload_sha256) values (${binding.commandId}, ${binding.ownerId}, ${binding.kind}, ${binding.targetId}, ${binding.expectedVersion}, ${digest}) returning *`) as Row[];
          receipt = rows[0]; claimed = true;
        }
      }
      if (!receipt || receipt.owner_id !== binding.ownerId || receipt.command_kind !== binding.kind || receipt.target_id !== binding.targetId || (receipt.expected_version === null ? null : Number(receipt.expected_version)) !== binding.expectedVersion || receipt.payload_sha256 !== digest) throw new CommandIdempotencyConflictError();
      await tx.execute(sql`with expired as (select command_id from app_private.list_command_receipts where command_id <> ${binding.commandId} and expires_at <= clock_timestamp() and result_version is not null order by expires_at, command_id limit 100 for update skip locked) delete from app_private.list_command_receipts r using expired where r.command_id = expired.command_id`);
      if (!claimed && receipt.result_id && receipt.result_version !== null) return { resourceId: String(receipt.result_id), version: Number(receipt.result_version), state: receipt.result_state as ListResult["state"], replayed: true };
      const result = await mutation(tx);
      await tx.execute(sql`update app_private.list_command_receipts set result_id = ${result.resourceId}, result_version = ${result.version}, result_state = ${result.state} where command_id = ${binding.commandId}`);
      return result;
    });
  }
}

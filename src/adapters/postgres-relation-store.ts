import "server-only";
import { sql } from "drizzle-orm";
import { referenceKey } from "./reference-key";
import type { ExternalGameRef } from "@/modules/games/internal/types";
import { CommandIdempotencyConflictError, CommandTargetNotFoundError, CommandVersionConflictError, commandPayloadSha256 } from "@/modules/commands";
import { RelationConflictError, RelationInvalidError, RelationStateConflictError, relationCommandBinding, type AddRelationCommand, type GameRelation, type RelationCommand, type RelationResult, type RelationStore, type RelationTarget } from "@/modules/relations";
import type { ProductionExecutor, QueryExecutor } from "./database-game-store";

type Row = Readonly<Record<string, unknown>>;
type Thumbnail = Readonly<{ state: "missing" | "pending" | "ready" | "failed"; url: string | null }>;
type Kind = "relation.add" | "relation.remove" | "relation.restore" | "relation.describe";
type Binding = Readonly<{ ownerId: string; commandId: string; kind: Kind; targetId: string | null; expectedVersion: number | null; payload: unknown }>;

function ref(row: Row, side: "left" | "right", thumbnail: { state: "missing" | "pending" | "ready" | "failed"; url: string | null }): RelationTarget {
  const gameId = row[`${side}_game_id`];
  if (gameId !== null && gameId !== undefined) return { kind: "game", gameId: String(gameId) };
  const provider = row[`${side}_provider`];
  const sourceId = row[`${side}_source_id`];
  const medium = row[`${side}_medium`];
  const externalName = row[`${side}_external_name`];
  if ((provider !== "bgg" && provider !== "igdb") || typeof sourceId !== "string" || typeof externalName !== "string") throw new RelationInvalidError();
  const external: ExternalGameRef = provider === "bgg" && medium === "board_game"
    ? { provider, sourceId, medium }
    : provider === "igdb" && medium === "video_game"
      ? { provider, sourceId, medium }
      : (() => { throw new RelationInvalidError(); })();
  return { kind: "external", ref: external, name: externalName, releaseYear: row[`${side}_release_year`] == null ? null : Number(row[`${side}_release_year`]), thumbnailState: thumbnail.state, thumbnailUrl: thumbnail.url };
}

function asRelation(row: Row, leftThumbnail: { state: "missing" | "pending" | "ready" | "failed"; url: string | null }, rightThumbnail: { state: "missing" | "pending" | "ready" | "failed"; url: string | null }): GameRelation {
  const leftGameId = row.left_resolved_game_id == null ? null : String(row.left_resolved_game_id);
  const rightGameId = row.right_resolved_game_id == null ? null : String(row.right_resolved_game_id);
  return {
    id: String(row.id), version: Number(row.version), left: ref(row, "left", leftThumbnail), right: ref(row, "right", rightThumbnail),
    leftGameId, rightGameId, leftTrashed: Boolean(row.left_trashed_at), rightTrashed: Boolean(row.right_trashed_at),
    description: row.description == null ? null : String(row.description), removed: row.removed_at !== null,
  };
}

export class PostgresRelationStore implements RelationStore {
  constructor(private readonly db: ProductionExecutor, private readonly issueThumbnailRead?: (objectKey: string) => Promise<string>) {}

  async forGame(gameId: string): Promise<readonly GameRelation[]> {
    const rows = await this.db.execute(sql`
      select r.*,
        coalesce(lg.id, li_game.id) as left_resolved_game_id, coalesce(lg.trashed_at, li_game.trashed_at) as left_trashed_at,
        coalesce(rg.id, ri_game.id) as right_resolved_game_id, coalesce(rg.trashed_at, ri_game.trashed_at) as right_trashed_at,
        coalesce(li.provider, l_game_identity.provider) as left_provider, coalesce(li.source_id, l_game_identity.source_id) as left_source_id,
        coalesce(li.medium, l_game_identity.medium) as left_medium, coalesce(lref.name, li.snapshot->>'title', l_game.display_name) as left_external_name, lref.release_year as left_release_year, lref.thumbnail_state as left_thumbnail_state, lref.thumbnail_object_key as left_thumbnail_object_key,
        coalesce(ri.provider, r_game_identity.provider) as right_provider, coalesce(ri.source_id, r_game_identity.source_id) as right_source_id,
        coalesce(ri.medium, r_game_identity.medium) as right_medium, coalesce(rref.name, ri.snapshot->>'title', r_game.display_name) as right_external_name, rref.release_year as right_release_year, rref.thumbnail_state as right_thumbnail_state, rref.thumbnail_object_key as right_thumbnail_object_key
      from app_private.game_relations r
      left join app_private.games l_game on l_game.id = r.left_game_id
      left join app_private.external_game_identities l_game_identity on l_game_identity.id = l_game.external_game_identity_id
      left join app_private.external_game_identities li on li.id = r.left_external_game_identity_id
      left join app_private.external_game_references lref on lref.external_game_identity_id = coalesce(li.id, l_game_identity.id)
      left join app_private.games lg on lg.external_game_identity_id = li.id
      left join app_private.games li_game on li_game.id = r.left_game_id
      left join app_private.games r_game on r_game.id = r.right_game_id
      left join app_private.external_game_identities r_game_identity on r_game_identity.id = r_game.external_game_identity_id
      left join app_private.external_game_identities ri on ri.id = r.right_external_game_identity_id
      left join app_private.external_game_references rref on rref.external_game_identity_id = coalesce(ri.id, r_game_identity.id)
      left join app_private.games rg on rg.external_game_identity_id = ri.id
      left join app_private.games ri_game on ri_game.id = r.right_game_id
      where r.removed_at is null and (
        r.left_game_id = ${gameId} or lg.id = ${gameId} or r.right_game_id = ${gameId} or rg.id = ${gameId}
      )
      order by lower(case
        when r.left_game_id = ${gameId} or lg.id = ${gameId} then coalesce(rg.display_name, ri_game.display_name, rref.name, ri.snapshot->>'title', '')
        else coalesce(lg.display_name, li_game.display_name, lref.name, li.snapshot->>'title', '')
      end), r.id
    `) as Row[];
    return Promise.all(rows.map(async (row) => {
      const leftThumbnail = await this.thumbnail(row, "left");
      const rightThumbnail = await this.thumbnail(row, "right");
      return asRelation(row, leftThumbnail, rightThumbnail);
    }));
  }

  private async thumbnail(row: Row, side: "left" | "right"): Promise<Thumbnail> {
    if (row[`${side}_resolved_game_id`] !== null && row[`${side}_resolved_game_id`] !== undefined) return { state: "missing" as const, url: null };
    const state = row[`${side}_thumbnail_state`];
    if (state !== "pending" && state !== "ready" && state !== "failed") return { state: "missing" as const, url: null };
    if (state !== "ready" || !row[`${side}_thumbnail_object_key`] || !this.issueThumbnailRead) return { state, url: null };
    try { return { state, url: await this.issueThumbnailRead(String(row[`${side}_thumbnail_object_key`])) }; }
    catch { return { state: "failed" as const, url: null }; }
  }

  async add(command: AddRelationCommand): Promise<RelationResult> {
    const leftBinding = relationCommandBinding(command.left); const rightBinding = relationCommandBinding(command.right);
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind: "relation.add", targetId: null, expectedVersion: null, payload: { left: leftBinding, right: rightBinding } }, async (tx) => {
      const targets = [command.left, command.right].sort((a, b) => relationCommandBinding(a).kind.localeCompare(relationCommandBinding(b).kind) || (a.kind === "game" ? a.gameId : `${a.ref.provider}:${a.ref.sourceId}`).localeCompare(b.kind === "game" ? b.gameId : `${b.ref.provider}:${b.ref.sourceId}`));
      for (const target of targets) {
        if (target.kind === "external") await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'source:' + target.ref.provider + ':' + target.ref.sourceId}, 0))`);
      }
      const locked = new Map<RelationTarget, Awaited<ReturnType<PostgresRelationStore["lockTarget"]>>>();
      for (const target of targets) locked.set(target, await this.lockTarget(tx, target));
      const pair = [locked.get(command.left)!, locked.get(command.right)!].sort((a, b) => a.key.localeCompare(b.key));
      if (pair[0].key === pair[1].key) throw new RelationInvalidError();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'relation:' + pair[0].key + '|' + pair[1].key}, 0))`);
      const existing = await tx.execute(sql`
        select r.id, r.version, r.removed_at,
          ${referenceKey(sql`r.left_external_game_identity_id`, sql`l.external_game_identity_id`, sql`r.left_game_id`)} as left_key,
          ${referenceKey(sql`r.right_external_game_identity_id`, sql`g.external_game_identity_id`, sql`r.right_game_id`)} as right_key
        from app_private.game_relations r
        left join app_private.games l on l.id = r.left_game_id
        left join app_private.games g on g.id = r.right_game_id
        where ${referenceKey(sql`r.left_external_game_identity_id`, sql`l.external_game_identity_id`, sql`r.left_game_id`)} in (${pair[0].key}, ${pair[1].key})
          and ${referenceKey(sql`r.right_external_game_identity_id`, sql`g.external_game_identity_id`, sql`r.right_game_id`)} in (${pair[0].key}, ${pair[1].key})
        for update of r
      `) as Row[];
      if (existing[0]) throw new RelationConflictError(existing[0].removed_at !== null, String(existing[0].id), Number(existing[0].version));
      const values = pair.map((endpoint) => endpoint.gameId ? { game: endpoint.gameId, identity: null } : { game: null, identity: endpoint.identityId });
      const rows = await tx.execute(sql`
        insert into app_private.game_relations(left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id)
        values (${values[0].game}, ${values[0].identity}, ${values[1].game}, ${values[1].identity}) returning id, version, removed_at
      `) as Row[];
      await this.bumpEndpointGameVersions(tx, values[0], values[1]);
      return this.result(rows[0], false);
    });
  }

  remove(command: RelationCommand) { return this.change(command, "relation.remove", "removed_at = clock_timestamp()", "removed"); }
  restore(command: RelationCommand) { return this.change(command, "relation.restore", "removed_at = null", "active"); }
  describe(command: RelationCommand & { description: string | null }) {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind: "relation.describe", targetId: command.relationId, expectedVersion: command.expectedVersion, payload: { description: command.description } }, async (tx) => {
      const relations = await tx.execute(sql`select left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id from app_private.game_relations where id = ${command.relationId}`) as Row[];
      if (relations[0]) {
        const relation = relations[0];
        const games = await tx.execute(sql`
          select id, trashed_at from app_private.games
          where id in (${relation.left_game_id}, ${relation.right_game_id})
             or external_game_identity_id in (${relation.left_external_game_identity_id}, ${relation.right_external_game_identity_id})
          order by id for update
        `) as Row[];
        if (games.some((game) => game.trashed_at !== null)) throw new RelationStateConflictError();
        await tx.execute(sql`select id from app_private.game_relations where id = ${command.relationId} for update`);
      }
      const rows = await tx.execute(sql`update app_private.game_relations set description = ${command.description}, version = version + 1, updated_at = clock_timestamp() where id = ${command.relationId} and version = ${command.expectedVersion} and removed_at is null returning id, version, removed_at`) as Row[];
      return rows[0] ? this.result(rows[0], false) : this.throwMissingOrConflict(tx, command.relationId, command.expectedVersion, "active");
    });
  }

  private change(command: RelationCommand, kind: "relation.remove" | "relation.restore", update: "removed_at = clock_timestamp()" | "removed_at = null", state: RelationResult["state"]) {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, kind, targetId: command.relationId, expectedVersion: command.expectedVersion, payload: {} }, async (tx) => {
      if (kind === "relation.restore") await this.assertCanRestore(tx, command.relationId, command.expectedVersion);
      const rows = await tx.execute(sql`update app_private.game_relations set ${sql.raw(update)}, version = version + 1, updated_at = clock_timestamp() where id = ${command.relationId} and version = ${command.expectedVersion} and ${kind === "relation.remove" ? sql`removed_at is null` : sql`removed_at is not null`} returning id, version, removed_at, left_game_id, left_external_game_identity_id, right_game_id, right_external_game_identity_id`) as Row[];
      if (rows[0]) {
        await this.bumpEndpointGameVersions(tx,
          { game: rows[0].left_game_id == null ? null : String(rows[0].left_game_id), identity: rows[0].left_external_game_identity_id == null ? null : String(rows[0].left_external_game_identity_id) },
          { game: rows[0].right_game_id == null ? null : String(rows[0].right_game_id), identity: rows[0].right_external_game_identity_id == null ? null : String(rows[0].right_external_game_identity_id) },
        );
        return { ...this.result(rows[0], false), state };
      }
      return this.throwMissingOrConflict(tx, command.relationId, command.expectedVersion, state);
    });
  }

  private bumpEndpointGameVersions(tx: QueryExecutor, left: { game: string | null; identity: string | null }, right: { game: string | null; identity: string | null }) {
    return tx.execute(sql`
      update app_private.games set version = version + 1
      where (id = ${left.game}::uuid or external_game_identity_id = ${left.identity}::uuid)
         or (id = ${right.game}::uuid or external_game_identity_id = ${right.identity}::uuid)
    `);
  }

  private async assertCanRestore(tx: QueryExecutor, relationId: string, expectedVersion: number) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('source-link-reference-collision', 0))`);
    const rows = await tx.execute(sql`
      select r.id, r.version, r.removed_at,
        ${referenceKey(sql`r.left_external_game_identity_id`, sql`left_game.external_game_identity_id`, sql`r.left_game_id`)} as left_key,
        ${referenceKey(sql`r.right_external_game_identity_id`, sql`right_game.external_game_identity_id`, sql`r.right_game_id`)} as right_key
      from app_private.game_relations r
      left join app_private.games left_game on left_game.id = r.left_game_id
      left join app_private.games right_game on right_game.id = r.right_game_id
      where r.id = ${relationId} for update of r
    `) as Row[];
    const target = rows[0];
    if (!target) throw new CommandTargetNotFoundError();
    if (Number(target.version) !== expectedVersion) throw new CommandVersionConflictError(Number(target.version), target.removed_at === null ? "active" : "removed");
    if (target.removed_at === null) throw new RelationStateConflictError();
    const leftKey = String(target.left_key); const rightKey = String(target.right_key);
    const first = leftKey < rightKey ? leftKey : rightKey; const second = leftKey < rightKey ? rightKey : leftKey;
    if (first === second) throw new RelationInvalidError();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'relation:' + first + '|' + second}, 0))`);
    const conflicts = await tx.execute(sql`
      select r.id, r.version from app_private.game_relations r
      left join app_private.games left_game on left_game.id = r.left_game_id
      left join app_private.games right_game on right_game.id = r.right_game_id
      where r.id <> ${relationId} and r.removed_at is null
        and ${referenceKey(sql`r.left_external_game_identity_id`, sql`left_game.external_game_identity_id`, sql`r.left_game_id`)} in (${first}, ${second})
        and ${referenceKey(sql`r.right_external_game_identity_id`, sql`right_game.external_game_identity_id`, sql`r.right_game_id`)} in (${first}, ${second})
      limit 1
    `) as Row[];
    if (conflicts[0]) throw new RelationConflictError(false, String(conflicts[0].id), Number(conflicts[0].version));
  }

  private async lockTarget(tx: QueryExecutor, target: RelationTarget): Promise<{ key: string; gameId: string | null; identityId: string | null }> {
    if (target.kind === "game") {
      const rows = await tx.execute(sql`select id, external_game_identity_id, trashed_at from app_private.games where id = ${target.gameId} for update`) as Row[];
      if (!rows[0] || rows[0].trashed_at !== null) throw new RelationInvalidError();
      return rows[0].external_game_identity_id ? { key: `0:${rows[0].external_game_identity_id}`, gameId: null, identityId: String(rows[0].external_game_identity_id) } : { key: `1:${target.gameId}`, gameId: target.gameId, identityId: null };
    }
    const { ref, name, releaseYear } = target;
    const snapshot = { ref, title: name.trim(), releaseYear };
    const rows = await tx.execute(sql`insert into app_private.external_game_identities(provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb) on conflict(provider, source_id) do update set provider = excluded.provider returning id, medium`) as Row[];
    if (!rows[0] || rows[0].medium !== ref.medium) throw new RelationInvalidError();
    const identityId = String(rows[0].id);
    await tx.execute(sql`insert into app_private.external_game_references(external_game_identity_id, name, release_year) values (${identityId}, ${name.trim()}, ${releaseYear}) on conflict (external_game_identity_id) do nothing`);
    const gameRows = await tx.execute(sql`select id, trashed_at from app_private.games where external_game_identity_id = ${identityId} for update`) as Row[];
    if (gameRows[0]?.trashed_at !== undefined && gameRows[0]?.trashed_at !== null) throw new RelationInvalidError();
    return { key: `0:${identityId}`, gameId: null, identityId };
  }

  private async execute(binding: Binding, operation: (tx: QueryExecutor) => Promise<RelationResult>): Promise<RelationResult> {
    const digest = commandPayloadSha256(binding.payload);
    return this.db.transaction(async (tx) => {
      let rows = await tx.execute(sql`insert into app_private.relation_command_receipts(command_id, owner_id, command_kind, target_id, expected_version, payload_sha256) values (${binding.commandId}, ${binding.ownerId}, ${binding.kind}, ${binding.targetId}, ${binding.expectedVersion}, ${digest}) on conflict (command_id) do nothing returning *`) as Row[];
      let claimed = rows.length > 0;
      let receipt = rows[0];
      if (!receipt) {
        rows = await tx.execute(sql`select * from app_private.relation_command_receipts where command_id = ${binding.commandId} for update`) as Row[];
        receipt = rows[0];
      }
      if (!receipt || receipt.owner_id !== binding.ownerId || receipt.command_kind !== binding.kind || receipt.target_id !== binding.targetId || (receipt.expected_version == null ? null : Number(receipt.expected_version)) !== binding.expectedVersion || receipt.payload_sha256 !== digest) throw new CommandIdempotencyConflictError();
      if (!claimed && receipt.result_id != null) {
        const expiry = await tx.execute(sql`select expires_at <= clock_timestamp() as expired from app_private.relation_command_receipts where command_id = ${binding.commandId}`) as Row[];
        if (expiry[0]?.expired === true) {
          await tx.execute(sql`delete from app_private.relation_command_receipts where command_id = ${binding.commandId}`);
          rows = await tx.execute(sql`insert into app_private.relation_command_receipts(command_id, owner_id, command_kind, target_id, expected_version, payload_sha256) values (${binding.commandId}, ${binding.ownerId}, ${binding.kind}, ${binding.targetId}, ${binding.expectedVersion}, ${digest}) returning *`) as Row[];
          receipt = rows[0]; claimed = true;
        }
      }
      if (!claimed && receipt.result_id != null) return { resourceId: String(receipt.result_id), version: Number(receipt.result_version), state: receipt.result_state as RelationResult["state"], replayed: true };
      await tx.execute(sql`with expired as (select command_id from app_private.relation_command_receipts where command_id <> ${binding.commandId} and expires_at <= clock_timestamp() and result_version is not null order by expires_at, command_id limit 100 for update skip locked) delete from app_private.relation_command_receipts r using expired where r.command_id = expired.command_id`);
      const result = await operation(tx);
      await tx.execute(sql`update app_private.relation_command_receipts set result_id = ${result.resourceId}, result_version = ${result.version}, result_state = ${result.state} where command_id = ${binding.commandId}`);
      return result;
    });
  }

  private result(row: Row, replayed: boolean): RelationResult {
    if (!row) throw new RelationInvalidError();
    return { resourceId: String(row.id), version: Number(row.version), state: row.removed_at === null ? "active" : "removed", replayed };
  }
  private async throwMissingOrConflict(tx: QueryExecutor, id: string, expectedVersion: number, expectedState: RelationResult["state"]): Promise<never> {
    const rows = await tx.execute(sql`select id, version, removed_at from app_private.game_relations where id = ${id} for update`) as Row[];
    if (!rows[0]) throw new CommandTargetNotFoundError();
    const currentState = rows[0].removed_at === null ? "active" : "removed";
    if (Number(rows[0].version) !== expectedVersion) throw new CommandVersionConflictError(Number(rows[0].version), currentState);
    if (currentState !== expectedState) throw new RelationStateConflictError();
    throw new RelationInvalidError();
  }
}

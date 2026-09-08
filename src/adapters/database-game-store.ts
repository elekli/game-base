import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { ContributorFacet, ContributorMatch, GameStore, GameEditInput, LegacyManualContributionInput, LibraryGameQuery, ManualContributionInput, ManualContributionResult, SharedLibraryItem } from "@/modules/games";
import type { ExternalGameRef, GameContribution, GameRecord, Medium, SourceCategory, SourceSnapshot } from "@/modules/games";
import { SourceGameUnavailableError, SourceIdentityConflictError, SourceMediumMismatchError, SourcePersistenceFailedError, SourceRefreshIdempotencyConflictError } from "@/modules/games";
import { beginSourceCoverIngest, isAllowedSourceCoverUrl } from "@/modules/media/internal/source-cover-ingest";
import { LibraryConflictError } from "@/modules/library/internal/errors";
import {
  CommandIdempotencyConflictError,
  CommandTargetNotFoundError,
  CommandVersionConflictError,
  commandPayloadSha256,
  normalizeGameEditPayload,
  type GameEditCommand,
  type VersionedCommandResult,
} from "@/modules/commands";

export type QueryExecutor = Readonly<{
  execute(query: SQL): Promise<unknown>;
}>;
export type ProductionExecutor = QueryExecutor & Readonly<{
  transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}>;
type Row = Readonly<Record<string, unknown>>;

export function sqlState(error: unknown): string | null {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const candidate = current as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate"]) {
      if (typeof candidate[key] === "string" && /^[0-9A-Z]{5}$/i.test(candidate[key])) return candidate[key];
    }
    current = candidate.cause;
  }
  return null;
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return [];
}

function snapshotSourceNames(snapshot: SourceSnapshot | null): readonly string[] {
  return snapshot ? [snapshot.title, snapshot.localizedTitle ?? "", ...snapshot.aliases].map((name) => name.trim()).filter(Boolean) : [];
}

function sourceContributions(snapshot: SourceSnapshot | null, row: Row): readonly GameContribution[] {
  const stored = jsonArray<Extract<GameContribution, { origin: "source" }>>(row.source_contributions);
  if (stored.length > 0) return stored.map((contribution) => ({ ...contribution, origin: "source" as const }));
  const localIds = new Map(jsonArray<{ contributorId: string; sourceContributorId: string }>(row.source_contributor_entities).map((entity) => [entity.sourceContributorId, entity.contributorId]));
  return snapshot?.contributors.map((contributor) => ({ id: `source:${snapshot.ref.provider}:${contributor.sourceContributorId}:${contributor.role}`, contributorId: localIds.get(contributor.sourceContributorId) ?? null, name: contributor.name, entityKind: contributor.entityKind, role: contributor.role, origin: "source" as const, provider: snapshot.ref.provider, sourceContributorId: contributor.sourceContributorId })) ?? [];
}

function withCurrentBggMetrics(snapshot: SourceSnapshot | null, row: Row): SourceSnapshot | null {
  if (!snapshot || snapshot.ref.provider !== "bgg" || row.metrics_identity_id === null || row.metrics_identity_id === undefined) return snapshot;
  return { ...snapshot, weight: row.metrics_weight === null ? null : Number(row.metrics_weight), strategyRank: row.metrics_strategy_rank === null ? null : Number(row.metrics_strategy_rank) };
}

function record(row: Row): GameRecord {
  const snapshot = withCurrentBggMetrics((row.snapshot as SourceSnapshot | null | undefined) ?? null, row);
  const manualContributions = jsonArray<GameContribution>(row.manual_contributions).map((contribution) => ({ ...contribution, contributorId: contribution.contributorId ?? contribution.id, origin: "manual" as const, provider: null, sourceContributorId: null }));
  return {
    id: String(row.id),
    version: Number(row.version),
    medium: row.medium as Medium,
    displayName: String(row.display_name),
    customDisplayName: row.custom_display_name ? String(row.custom_display_name) : null,
    sourceNames: jsonArray<string>(row.source_names).length > 0 ? jsonArray<string>(row.source_names) : snapshotSourceNames(snapshot),
    aliases: snapshot?.aliases ?? [],
    actualPlatforms: jsonArray<string>(row.actual_platforms),
    tags: jsonArray<string>(row.tags),
    contributors: [...sourceContributions(snapshot, row), ...manualContributions],
    playerCountNote: row.player_count_note ? String(row.player_count_note) : null,
    coverIngestState: row.cover_ingest_state === "pending" || row.cover_ingest_state === "ready" || row.cover_ingest_state === "failed" ? row.cover_ingest_state : null,
    coverAssetId: row.cover_asset_id ? String(row.cover_asset_id) : null,
    coverThumbnailState: row.cover_thumbnail_state === "pending" || row.cover_thumbnail_state === "processing" || row.cover_thumbnail_state === "ready" || row.cover_thumbnail_state === "failed" ? row.cover_thumbnail_state : null,
    externalIdentityId: row.external_game_identity_id ? String(row.external_game_identity_id) : null,
    snapshot,
    trashedAt: row.trashed_at ? String(row.trashed_at) : null,
    createdAt: String(row.created_at),
  };
}

function sourceRows(snapshot: SourceSnapshot) {
  return {
    categories: snapshot.categories,
    contributors: snapshot.contributors,
    supportedPlatforms: snapshot.supportedPlatforms,
  };
}

function assertVideoGamePlatforms(medium: Medium, platforms: readonly string[]) {
  if (medium === "board_game" && platforms.length > 0) throw new Error("桌遊不可設定實際平台。");
}

function normalized(value: string): string { return value.trim().toLocaleLowerCase("en-US"); }

function uniqueNames(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const displayName = value.trim();
    const key = normalized(displayName);
    if (key && !seen.has(key)) { seen.add(key); result.push(displayName); }
  }
  return result;
}

export class PostgresGameStore implements GameStore {
  constructor(private readonly db: ProductionExecutor) {}

  private async deleteExpiredCommandReceipts(executor: QueryExecutor, limit: number): Promise<number> {
    const rows = await executor.execute(sql`
      with expired as (
        select command_id from app_private.command_receipts
        where expires_at <= now() and result_version is not null
        order by expires_at, command_id
        limit ${limit}
        for update skip locked
      )
      delete from app_private.command_receipts receipt
      using expired
      where receipt.command_id = expired.command_id
      returning receipt.command_id
    `) as Row[];
    return rows.length;
  }

  private readonly selectFields = sql`g.id, g.version, g.medium, g.display_name, g.player_count_note, g.external_game_identity_id, g.trashed_at, g.created_at, custom_name.name as custom_display_name, i.snapshot,
    coalesce(g.manual_cover_asset_id, i.source_cover_asset_id) as cover_asset_id,
    (select derivative.state from app_private.media_derivatives derivative
      where derivative.asset_id = coalesce(g.manual_cover_asset_id, i.source_cover_asset_id)
        and derivative.authority_state = 'verified' and derivative.spec = 'thumb_webp_v1'
      limit 1) as cover_thumbnail_state,
    coalesce((select jsonb_agg(gn.name order by gn.id) from app_private.game_names gn where gn.game_id = g.id and gn.name_kind in ('source', 'alias')), '[]'::jsonb) as source_names,
    coalesce((select jsonb_agg(p.name order by p.name) from app_private.game_platforms gp join app_private.platforms p on p.id = gp.platform_id where gp.game_id = g.id), '[]'::jsonb) as actual_platforms,
    coalesce((select jsonb_agg(t.name order by t.name) from app_private.game_tags gt join app_private.tags t on t.id = gt.tag_id where gt.game_id = g.id), '[]'::jsonb) as tags,
    bcm.identity_id as metrics_identity_id, bcm.weight as metrics_weight, bcm.strategy_rank as metrics_strategy_rank,
    coalesce((select jsonb_agg(jsonb_build_object('id', sc.id, 'contributorId', c.id, 'name', c.name, 'entityKind', c.entity_kind, 'role', sc.role, 'provider', c.source_provider, 'sourceContributorId', c.source_contributor_id)) from app_private.source_contributions sc join app_private.contributors c on c.id = sc.contributor_id where sc.identity_id = i.id), '[]'::jsonb) as source_contributions,
    coalesce((select jsonb_agg(jsonb_build_object('contributorId', c.id, 'sourceContributorId', c.source_contributor_id)) from app_private.contributors c where not exists (select 1 from app_private.source_contributions linked where linked.identity_id = i.id) and c.source_provider = i.provider and exists (select 1 from jsonb_array_elements(coalesce(i.snapshot -> 'contributors', '[]'::jsonb)) contributor where contributor ->> 'sourceContributorId' = c.source_contributor_id)), '[]'::jsonb) as source_contributor_entities,
    coalesce((select jsonb_agg(jsonb_build_object('id', mc.id, 'contributorId', c.id, 'name', c.name, 'entityKind', c.entity_kind, 'role', mc.role)) from app_private.manual_contributions mc join app_private.contributors c on c.id = mc.contributor_id where mc.game_id = g.id), '[]'::jsonb) as manual_contributions,
    (select case
      when mi.original_state = 'failed' or mi.thumbnail_state = 'failed' then 'failed'
      when mi.original_state = 'ready' and mi.thumbnail_state = 'ready' and exists (
        select 1 from app_private.media_assets asset where asset.ingest_id = mi.id and asset.authority_state = 'verified'
      ) then 'ready'
      else 'pending'
    end from app_private.media_ingests mi where mi.game_id = g.id and mi.source_url = i.snapshot ->> 'coverUrl' order by mi.created_at desc, mi.id desc limit 1) as cover_ingest_state`;

  private selectFrom(where: SQL) {
    return sql`select ${this.selectFields} from app_private.games g left join app_private.external_game_identities i on i.id = g.external_game_identity_id left join app_private.bgg_current_metrics bcm on bcm.identity_id = i.id and i.provider = 'bgg' left join app_private.game_names custom_name on custom_name.game_id = g.id and custom_name.name_kind = 'custom' ${where}`;
  }

  async list(query = ""): Promise<readonly GameRecord[]> {
    return this.listLibraryGames({ search: query });
  }

  async listLibraryGames(query: LibraryGameQuery = {}): Promise<readonly GameRecord[]> {
    const clauses: SQL[] = [sql`g.trashed_at is null`];
    const search = query.search?.trim().replace(/[\\%_]/g, "\\$&");
    if (search) {
      const needle = `%${search}%`;
      clauses.push(sql`(g.display_name ilike ${needle} escape '\\' or exists (select 1 from app_private.game_names gn where gn.game_id = g.id and gn.name ilike ${needle} escape '\\'))`);
    }
    if (query.media?.length) clauses.push(sql`g.medium in (${sql.join(query.media.map((medium) => sql`${medium}`), sql`, `)})`);
    const actualPlatforms = uniqueNames(query.actualPlatforms ?? []).map(normalized);
    if (actualPlatforms.length) clauses.push(sql`exists (select 1 from app_private.game_platforms gp join app_private.platforms p on p.id = gp.platform_id where gp.game_id = g.id and p.normalized_name in (${sql.join(actualPlatforms.map((name) => sql`${name}`), sql`, `)}))`);
    const tags = uniqueNames(query.tags ?? []).map(normalized);
    if (tags.length) clauses.push(sql`exists (select 1 from app_private.game_tags gt join app_private.tags t on t.id = gt.tag_id where gt.game_id = g.id and t.normalized_name in (${sql.join(tags.map((name) => sql`${name}`), sql`, `)}))`);
    const contributorIds = [...new Set(query.contributorIds ?? [])];
    if (contributorIds.length) clauses.push(sql`(
      exists (select 1 from app_private.source_contributions sc where sc.identity_id = i.id and sc.contributor_id in (${sql.join(contributorIds.map((id) => sql`${id}`), sql`, `)}))
      or exists (select 1 from app_private.manual_contributions mc where mc.game_id = g.id and mc.contributor_id in (${sql.join(contributorIds.map((id) => sql`${id}`), sql`, `)}))
      or exists (select 1 from app_private.contributors c where c.id in (${sql.join(contributorIds.map((id) => sql`${id}`), sql`, `)}) and c.source_provider = i.provider and exists (select 1 from jsonb_array_elements(coalesce(i.snapshot -> 'contributors', '[]'::jsonb)) contributor where contributor ->> 'sourceContributorId' = c.source_contributor_id))
    )`);
    const contributorsByRole = new Map<string, Set<string>>();
    for (const { role, contributorIds: selectedIds } of query.contributorRoles ?? []) {
      const ids = contributorsByRole.get(role) ?? new Set<string>();
      for (const id of selectedIds) ids.add(id);
      contributorsByRole.set(role, ids);
    }
    for (const [role, selectedIds] of contributorsByRole) {
      const ids = [...selectedIds];
      if (ids.length === 0) continue;
      clauses.push(sql`(
        exists (select 1 from app_private.source_contributions sc where sc.identity_id = i.id and sc.role = ${role} and sc.contributor_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))
        or exists (select 1 from app_private.manual_contributions mc where mc.game_id = g.id and mc.role = ${role} and mc.contributor_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))
        or exists (select 1 from app_private.contributors c where c.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and c.source_provider = i.provider and exists (select 1 from jsonb_array_elements(coalesce(i.snapshot -> 'contributors', '[]'::jsonb)) contributor where contributor ->> 'sourceContributorId' = c.source_contributor_id and contributor ->> 'role' = ${role}))
      )`);
    }
    const selectedByKind = new Map<string, string[]>();
    for (const category of query.sourceCategories ?? []) {
      const ids = selectedByKind.get(category.kind) ?? [];
      if (!ids.includes(category.sourceCategoryId)) ids.push(category.sourceCategoryId);
      selectedByKind.set(category.kind, ids);
    }
    for (const [kind, ids] of selectedByKind) {
      clauses.push(sql`exists (select 1 from app_private.external_game_categories ec join app_private.source_categories sc on sc.id = ec.category_id where ec.identity_id = i.id and sc.provider = i.provider and sc.category_kind = ${kind} and sc.source_category_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`);
    }
    if (query.weightMin !== undefined && query.weightMin !== null) clauses.push(sql`bcm.weight >= ${query.weightMin}`);
    if (query.weightMax !== undefined && query.weightMax !== null) clauses.push(sql`bcm.weight <= ${query.weightMax}`);
    const orderBy = query.sort === "recent"
      ? sql`g.created_at desc, g.id asc`
      : query.sort === "weight_asc"
        ? sql`bcm.weight asc nulls last, g.display_name asc, g.id asc`
        : query.sort === "weight_desc"
          ? sql`bcm.weight desc nulls last, g.display_name asc, g.id asc`
          : query.sort === "strategy_rank"
            ? sql`bcm.strategy_rank asc nulls last, g.display_name asc, g.id asc`
            : sql`g.display_name asc, g.id asc`;
    const rows = await this.db.execute(this.selectFrom(sql`where ${sql.join(clauses, sql` and `)} order by ${orderBy}`)) as Row[];
    return rows.map(record);
  }

  async listSourceCategoryFacets(medium: Medium): Promise<readonly SourceCategory[]> {
    const provider = medium === "board_game" ? "bgg" : "igdb";
    const kinds = medium === "board_game" ? ["category", "mechanic"] : ["genre", "theme", "game_mode", "player_perspective"];
    const rows = await this.db.execute(sql`
      select distinct sc.category_kind as kind, sc.source_category_id, sc.name
      from app_private.games g
      join app_private.external_game_identities i on i.id = g.external_game_identity_id
      join app_private.external_game_categories ec on ec.identity_id = i.id
      join app_private.source_categories sc on sc.id = ec.category_id
      where g.trashed_at is null and g.medium = ${medium} and i.provider = ${provider}
        and sc.provider = ${provider}
        and sc.category_kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
      order by sc.name asc, sc.category_kind asc, sc.source_category_id asc
    `) as Row[];
    return rows.map((row) => ({ kind: String(row.kind), sourceCategoryId: String(row.source_category_id), name: String(row.name) }));
  }

  async listContributorFacets(): Promise<readonly ContributorFacet[]> {
    const rows = await this.db.execute(sql`
      select distinct contributor_id, name, entity_kind, source_provider, role from (
        select c.id as contributor_id, c.name, c.entity_kind, c.source_provider, sc.role
        from app_private.games g
        join app_private.source_contributions sc on sc.identity_id = g.external_game_identity_id
        join app_private.contributors c on c.id = sc.contributor_id
        where g.trashed_at is null
        union
        select c.id as contributor_id, c.name, c.entity_kind, c.source_provider, mc.role
        from app_private.games g
        join app_private.manual_contributions mc on mc.game_id = g.id
        join app_private.contributors c on c.id = mc.contributor_id
        where g.trashed_at is null
        union
        select c.id as contributor_id, c.name, c.entity_kind, c.source_provider, contributor ->> 'role' as role
        from app_private.games g
        join app_private.external_game_identities i on i.id = g.external_game_identity_id
        cross join lateral jsonb_array_elements(coalesce(i.snapshot -> 'contributors', '[]'::jsonb)) contributor
        join app_private.contributors c on c.source_provider = i.provider and c.source_contributor_id = contributor ->> 'sourceContributorId'
        where g.trashed_at is null
          and not exists (select 1 from app_private.source_contributions sc where sc.identity_id = i.id)
      ) facets
      order by role asc, name asc, contributor_id asc
    `) as Row[];
    return rows.map((row) => ({ contributorId: String(row.contributor_id), name: String(row.name), entityKind: row.entity_kind as ContributorFacet["entityKind"], provider: row.source_provider === "bgg" || row.source_provider === "igdb" ? row.source_provider : null, role: row.role as ContributorFacet["role"] }));
  }

  private async readGame(executor: QueryExecutor, id: string): Promise<GameRecord | null> {
    const rows = await executor.execute(this.selectFrom(sql`where g.id = ${id} limit 1`)) as Row[];
    return rows[0] ? record(rows[0]) : null;
  }

  async get(id: string): Promise<GameRecord | null> { return this.readGame(this.db, id); }

  async createManual(displayName: string, medium: Medium): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const run = async (tx: QueryExecutor) => {
      const rows = await tx.execute(sql`insert into app_private.games (medium, display_name) values (${medium}, ${title}) returning id, version, medium, display_name, player_count_note, external_game_identity_id, trashed_at, created_at`) as Row[];
      await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${String(rows[0].id)}, ${title}, 'custom')`);
      return rows[0];
    };
    const row = await this.db.transaction(run);
    return record({ ...row, custom_display_name: title, source_names: [], actual_platforms: [], tags: [], manual_contributions: [] });
  }

  private async writeSourceRows(tx: QueryExecutor, identityId: string, snapshot: SourceSnapshot) {
    const rows = sourceRows(snapshot);
    for (const category of rows.categories) {
      const categoryRows = await tx.execute(sql`insert into app_private.source_categories (provider, category_kind, source_category_id, name) values (${snapshot.ref.provider}, ${category.kind}, ${category.sourceCategoryId}, ${category.name}) on conflict (provider, category_kind, source_category_id) do update set name = excluded.name returning id`) as Row[];
      await tx.execute(sql`insert into app_private.external_game_categories (identity_id, category_id) values (${identityId}, ${String(categoryRows[0].id)}) on conflict do nothing`);
    }
    for (const contributor of rows.contributors) {
      const contributorRows = await tx.execute(sql`insert into app_private.contributors (name, entity_kind, source_provider, source_contributor_id) values (${contributor.name}, ${contributor.entityKind}, ${snapshot.ref.provider}, ${contributor.sourceContributorId}) on conflict (source_provider, source_contributor_id) where source_provider is not null do update set name = excluded.name, entity_kind = excluded.entity_kind returning id`) as Row[];
      await tx.execute(sql`insert into app_private.source_contributions (identity_id, contributor_id, source_contributor_id, name, entity_kind, role) values (${identityId}, ${String(contributorRows[0].id)}, ${contributor.sourceContributorId}, ${contributor.name}, ${contributor.entityKind}, ${contributor.role}) on conflict (identity_id, source_contributor_id, role) do update set contributor_id = excluded.contributor_id, name = excluded.name, entity_kind = excluded.entity_kind`);
    }
    if (snapshot.minPlayers !== null || snapshot.maxPlayers !== null) {
      await tx.execute(sql`insert into app_private.external_player_profiles (identity_id, min_players, max_players, supports_solo) values (${identityId}, ${snapshot.minPlayers}, ${snapshot.maxPlayers}, ${snapshot.supportsSolo}) on conflict (identity_id) do update set min_players = excluded.min_players, max_players = excluded.max_players, supports_solo = excluded.supports_solo`);
    } else {
      await tx.execute(sql`insert into app_private.external_player_profiles (identity_id, min_players, max_players, supports_solo) values (${identityId}, null, null, ${snapshot.supportsSolo}) on conflict (identity_id) do update set min_players = null, max_players = null, supports_solo = excluded.supports_solo`);
    }
    for (const platform of rows.supportedPlatforms) await tx.execute(sql`insert into app_private.external_supported_platforms (identity_id, name) values (${identityId}, ${platform}) on conflict (identity_id, normalized_name) do update set name = excluded.name`);
    if (snapshot.ref.provider === "bgg") await tx.execute(sql`insert into app_private.bgg_current_metrics (identity_id, weight, strategy_rank, last_successful_sync_at) values (${identityId}, ${snapshot.weight}, ${snapshot.strategyRank}, now()) on conflict (identity_id) do update set weight = excluded.weight, strategy_rank = excluded.strategy_rank, last_successful_sync_at = excluded.last_successful_sync_at`);
  }

  private async writeSourceNames(tx: QueryExecutor, gameId: string, snapshot: SourceSnapshot) {
    await tx.execute(sql`delete from app_private.game_names where game_id = ${gameId} and name_kind in ('source', 'alias')`);
    await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${gameId}, ${snapshot.title}, 'source') on conflict do nothing`);
    if (snapshot.localizedTitle) await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${gameId}, ${snapshot.localizedTitle}, 'source') on conflict do nothing`);
    for (const alias of uniqueNames(snapshot.aliases)) await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${gameId}, ${alias}, 'alias') on conflict do nothing`);
  }

  private async writeSourceCoverIngest(tx: QueryExecutor, operationId: string, gameId: string, identityId: string, snapshot: SourceSnapshot) {
    if (!snapshot.coverUrl || !isAllowedSourceCoverUrl(snapshot.coverUrl)) return;
    const ingest = beginSourceCoverIngest(operationId, gameId, identityId, snapshot.coverUrl);
    await tx.execute(sql`insert into app_private.media_ingests (
      id, idempotency_key, reserved_asset_id, channel, purpose, game_id, external_game_identity_id, original_object_path,
      original_file_name, declared_mime_type, state, stale_after,
      source_url, object_key, original_state, thumbnail_state
    ) values (
      ${ingest.id}, ${ingest.idempotencyKey}, ${ingest.reservedAssetId}, 'source_fetch', 'source_cover', ${gameId}, ${ingest.externalGameIdentityId}, ${ingest.objectKey},
      'source-cover', 'application/octet-stream', 'issued', now() + interval '26 hours',
      ${ingest.sourceUrl}, ${ingest.objectKey}, ${ingest.originalState}, ${ingest.thumbnailState}
    )`);
  }

  async createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }> {
    const sourceCoverOperationId = randomUUID();
    const run = async (tx: QueryExecutor) => {
      const identityRows = await tx.execute(sql`insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb) returning id`) as Row[];
      const identityId = String(identityRows[0].id);
      const gameRows = await tx.execute(sql`insert into app_private.games (medium, display_name, external_game_identity_id) values (${ref.medium}, ${snapshot.title}, ${identityId}) returning id, version, medium, display_name, player_count_note, external_game_identity_id, trashed_at, created_at`) as Row[];
      const gameId = String(gameRows[0].id);
      await this.writeSourceNames(tx, gameId, snapshot);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceCoverIngest(tx, sourceCoverOperationId, gameId, identityId, snapshot);
      return { gameId, created: true };
    };
    try {
      const created = await this.db.transaction(run);
      const game = await this.get(created.gameId);
      if (!game) throw new SourcePersistenceFailedError();
      return { game, created: true };
    }
    catch (error) {
      if (sqlState(error) === "23505") {
        const conflict = await this.db.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} limit 1`) as Row[];
        if (conflict[0]) throw new SourceIdentityConflictError(String(conflict[0].id), Boolean(conflict[0].trashed_at));
      }
      throw error;
    }
  }

  async linkFromSource(gameId: string, ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<GameRecord> {
    const sourceCoverOperationId = randomUUID();
    const run = async (tx: QueryExecutor) => {
      const gameRows = await tx.execute(sql`select id, medium, external_game_identity_id, trashed_at from app_private.games where id = ${gameId} for update`) as Row[];
      if (!gameRows[0]) throw new SourcePersistenceFailedError();
      if (gameRows[0].trashed_at) throw new SourceGameUnavailableError();
      if (gameRows[0].external_game_identity_id) throw new SourcePersistenceFailedError();
      if (gameRows[0].medium !== ref.medium) throw new SourceMediumMismatchError();
      const existing = await tx.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} for update`) as Row[];
      if (existing[0]) throw new SourceIdentityConflictError(String(existing[0].id), Boolean(existing[0].trashed_at));
      const identityRows = await tx.execute(sql`insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb) returning id`) as Row[];
      const identityId = String(identityRows[0].id);
      await tx.execute(sql`update app_private.games set external_game_identity_id = ${identityId}, display_name = coalesce((select name from app_private.game_names where game_id = ${gameId} and name_kind = 'custom'), ${snapshot.title}) where id = ${gameId}`);
      await this.writeSourceNames(tx, gameId, snapshot);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceCoverIngest(tx, sourceCoverOperationId, gameId, identityId, snapshot);
    };
    try { await this.db.transaction(run); }
    catch (error) {
      if (error instanceof SourceGameUnavailableError || error instanceof SourceIdentityConflictError || error instanceof SourceMediumMismatchError) throw error;
      if (sqlState(error) === "23505") {
        const conflict = await this.db.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} limit 1`) as Row[];
        if (conflict[0]) throw new SourceIdentityConflictError(String(conflict[0].id), Boolean(conflict[0].trashed_at));
      }
      throw error;
    }
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async refreshSource(gameId: string, snapshot: SourceSnapshot, sourceCoverOperationId: string): Promise<GameRecord> {
    const payloadFingerprint = createHash("sha256").update(JSON.stringify({ gameId, snapshot, coverUrl: snapshot.coverUrl })).digest("hex");
    const run = async (tx: QueryExecutor) => {
      const rows = await tx.execute(sql`select g.external_game_identity_id, g.trashed_at from app_private.games g where g.id = ${gameId} and g.external_game_identity_id is not null for update`) as Row[];
      if (!rows[0]) throw new SourcePersistenceFailedError();
      if (rows[0].trashed_at) throw new SourceGameUnavailableError();
      const identityId = String(rows[0].external_game_identity_id);
      const receipt = await tx.execute(sql`
        insert into app_private.source_refresh_operations (operation_id, game_id, external_game_identity_id, payload_fingerprint)
        values (${sourceCoverOperationId}, ${gameId}, ${identityId}, ${payloadFingerprint})
        on conflict (operation_id) do nothing
        returning payload_fingerprint
      `) as Row[];
      if (!receipt[0]) {
        const existing = await tx.execute(sql`select game_id, external_game_identity_id, payload_fingerprint from app_private.source_refresh_operations where operation_id = ${sourceCoverOperationId}`) as Row[];
        if (existing[0]?.payload_fingerprint !== payloadFingerprint || String(existing[0]?.game_id) !== gameId || String(existing[0]?.external_game_identity_id) !== identityId) throw new SourceRefreshIdempotencyConflictError();
        return;
      }
      await tx.execute(sql`update app_private.external_game_identities set snapshot = ${JSON.stringify(snapshot)}::jsonb, updated_at = now() where id = ${identityId}`);
      await tx.execute(sql`delete from app_private.external_game_categories where identity_id = ${identityId}`);
      await tx.execute(sql`delete from app_private.source_contributions where identity_id = ${identityId}`);
      await tx.execute(sql`delete from app_private.external_supported_platforms where identity_id = ${identityId}`);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceNames(tx, gameId, snapshot);
      await tx.execute(sql`update app_private.games set display_name = coalesce((select name from app_private.game_names where game_id = ${gameId} and name_kind = 'custom'), ${snapshot.title}) where id = ${gameId}`);
      await this.writeSourceCoverIngest(tx, sourceCoverOperationId, gameId, identityId, snapshot);
    };
    await this.db.transaction(run);
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async edit(gameId: string, input: GameEditInput): Promise<GameRecord> {
    const current = await this.get(gameId);
    if (!current) throw new SourcePersistenceFailedError();
    const actualPlatforms = input.actualPlatforms === undefined ? current.actualPlatforms : uniqueNames(input.actualPlatforms);
    assertVideoGamePlatforms(current.medium, actualPlatforms);
    const tags = input.tags === undefined ? current.tags : uniqueNames(input.tags);
    const run = async (tx: QueryExecutor) => {
      if (input.displayName !== undefined) {
        if (input.displayName === null || !input.displayName.trim()) await tx.execute(sql`delete from app_private.game_names where game_id = ${gameId} and name_kind = 'custom'`);
        else await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${gameId}, ${input.displayName.trim()}, 'custom') on conflict (game_id, name_kind) where name_kind = 'custom' do update set name = excluded.name`);
      }
      if (input.actualPlatforms !== undefined) {
        await tx.execute(sql`delete from app_private.game_platforms where game_id = ${gameId}`);
        for (const name of actualPlatforms) {
          const platformRows = await tx.execute(sql`insert into app_private.platforms (name, normalized_name, is_system) values (${name}, ${normalized(name)}, false) on conflict (normalized_name) do update set name = app_private.platforms.name returning id`) as Row[];
          await tx.execute(sql`insert into app_private.game_platforms (game_id, platform_id) values (${gameId}, ${String(platformRows[0].id)}) on conflict do nothing`);
        }
      }
      if (input.tags !== undefined) {
        await tx.execute(sql`delete from app_private.game_tags where game_id = ${gameId}`);
        for (const name of tags) {
          const tagRows = await tx.execute(sql`insert into app_private.tags (name, normalized_name) values (${name}, ${normalized(name)}) on conflict (normalized_name) do update set name = app_private.tags.name returning id`) as Row[];
          await tx.execute(sql`insert into app_private.game_tags (game_id, tag_id) values (${gameId}, ${String(tagRows[0].id)}) on conflict do nothing`);
        }
      }
      if (input.playerCountNote !== undefined) await tx.execute(sql`update app_private.games set player_count_note = ${input.playerCountNote?.trim() || null} where id = ${gameId}`);
      if (input.displayName !== undefined && input.displayName !== null && input.displayName.trim()) await tx.execute(sql`update app_private.games set display_name = ${input.displayName.trim()} where id = ${gameId}`);
      else if (input.displayName === null || (input.displayName !== undefined && !input.displayName.trim())) await tx.execute(sql`update app_private.games set display_name = coalesce((select name from app_private.game_names where game_id = ${gameId} and name_kind = 'source' order by id limit 1), display_name) where id = ${gameId}`);
    };
    await this.db.transaction(run);
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async editWithCommand(command: GameEditCommand): Promise<VersionedCommandResult> {
    const payload = normalizeGameEditPayload(command.payload);
    const payloadSha256 = commandPayloadSha256(payload);
    return this.db.transaction(async (tx) => {
      await this.deleteExpiredCommandReceipts(tx, 100);
      const claimed = await tx.execute(sql`
        insert into app_private.command_receipts
          (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256)
        values
          (${command.commandId}, ${command.ownerId}, 'game.edit', 'game', ${command.gameId}, ${command.expectedVersion}, ${payloadSha256})
        on conflict (command_id) do nothing
        returning command_id
      `) as Row[];
      const receiptRows = await tx.execute(sql`
        select owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256, result_version, result_state
        from app_private.command_receipts
        where command_id = ${command.commandId}
        for update
      `) as Row[];
      const receipt = receiptRows[0];
      if (!receipt) throw new SourcePersistenceFailedError();
      if (
        String(receipt.owner_id) !== command.ownerId
        || receipt.command_kind !== "game.edit"
        || receipt.target_kind !== "game"
        || String(receipt.target_id) !== command.gameId
        || Number(receipt.expected_version) !== command.expectedVersion
        || receipt.payload_sha256 !== payloadSha256
      ) throw new CommandIdempotencyConflictError();
      if (claimed.length === 0 && receipt.result_version !== null && receipt.result_state !== null) {
        return {
          resourceId: command.gameId,
          version: Number(receipt.result_version),
          state: receipt.result_state as VersionedCommandResult["state"],
          replayed: true,
        };
      }

      const gameRows = await tx.execute(sql`
        select id, version, medium, trashed_at
        from app_private.games
        where id = ${command.gameId}
        for update
      `) as Row[];
      const game = gameRows[0];
      if (!game) throw new CommandTargetNotFoundError();
      const state = game.trashed_at === null ? "active" as const : "trashed" as const;
      if (Number(game.version) !== command.expectedVersion) throw new CommandVersionConflictError(Number(game.version), state);

      const actualPlatforms = payload.actualPlatforms ?? undefined;
      if (actualPlatforms !== undefined) assertVideoGamePlatforms(game.medium as Medium, actualPlatforms);
      if (payload.displayName !== undefined) {
        if (payload.displayName === null) await tx.execute(sql`delete from app_private.game_names where game_id = ${command.gameId} and name_kind = 'custom'`);
        else await tx.execute(sql`insert into app_private.game_names (game_id, name, name_kind) values (${command.gameId}, ${payload.displayName}, 'custom') on conflict (game_id, name_kind) where name_kind = 'custom' do update set name = excluded.name`);
      }
      if (actualPlatforms !== undefined) {
        await tx.execute(sql`delete from app_private.game_platforms where game_id = ${command.gameId}`);
        for (const name of actualPlatforms) {
          const platformRows = await tx.execute(sql`insert into app_private.platforms (name, normalized_name, is_system) values (${name}, ${normalized(name)}, false) on conflict (normalized_name) do update set name = app_private.platforms.name returning id`) as Row[];
          await tx.execute(sql`insert into app_private.game_platforms (game_id, platform_id) values (${command.gameId}, ${String(platformRows[0].id)}) on conflict do nothing`);
        }
      }
      if (payload.tags !== undefined) {
        await tx.execute(sql`delete from app_private.game_tags where game_id = ${command.gameId}`);
        for (const name of payload.tags) {
          const tagRows = await tx.execute(sql`insert into app_private.tags (name, normalized_name) values (${name}, ${normalized(name)}) on conflict (normalized_name) do update set name = app_private.tags.name returning id`) as Row[];
          await tx.execute(sql`insert into app_private.game_tags (game_id, tag_id) values (${command.gameId}, ${String(tagRows[0].id)}) on conflict do nothing`);
        }
      }
      if (payload.playerCountNote !== undefined) {
        await tx.execute(sql`update app_private.games set player_count_note = ${payload.playerCountNote} where id = ${command.gameId}`);
      }
      if (payload.displayName !== undefined) {
        if (payload.displayName === null) {
          await tx.execute(sql`update app_private.games set display_name = coalesce((select name from app_private.game_names where game_id = ${command.gameId} and name_kind = 'source' order by id limit 1), display_name) where id = ${command.gameId}`);
        } else {
          await tx.execute(sql`update app_private.games set display_name = ${payload.displayName} where id = ${command.gameId}`);
        }
      }
      const updatedRows = await tx.execute(sql`update app_private.games set version = version + 1 where id = ${command.gameId} returning version, trashed_at`) as Row[];
      const updated = updatedRows[0];
      if (!updated) throw new SourcePersistenceFailedError();
      const result = {
        resourceId: command.gameId,
        version: Number(updated.version),
        state: updated.trashed_at === null ? "active" as const : "trashed" as const,
        replayed: false,
      };
      await tx.execute(sql`
        update app_private.command_receipts
        set result_version = ${result.version}, result_state = ${result.state}
        where command_id = ${command.commandId}
      `);
      return result;
    });
  }

  async cleanupExpiredCommandReceipts(limit: number): Promise<number> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 500));
    if (boundedLimit === 0) return 0;
    return this.deleteExpiredCommandReceipts(this.db, boundedLimit);
  }

  private async readContributorMatches(executor: QueryExecutor, gameId: string, name: string): Promise<readonly ContributorMatch[]> {
    const rows = await executor.execute(sql`
      select c.id as contributor_id, c.name, c.entity_kind, c.source_provider, c.source_contributor_id,
        coalesce((
          select jsonb_agg(role order by role) from (
            select mc.role from app_private.manual_contributions mc where mc.game_id = ${gameId} and mc.contributor_id = c.id
            union
            select sc.role from app_private.games g
              join app_private.source_contributions sc on sc.identity_id = g.external_game_identity_id
              where g.id = ${gameId} and sc.contributor_id = c.id
          ) roles
        ), '[]'::jsonb) as roles_on_game
      from app_private.contributors c
      where lower(btrim(c.name)) = ${normalized(name)}
      order by c.id asc
    `) as Row[];
    return rows.map((row) => ({
      contributorId: String(row.contributor_id),
      name: String(row.name),
      entityKind: row.entity_kind as ContributorMatch["entityKind"],
      provider: row.source_provider === "bgg" || row.source_provider === "igdb" ? row.source_provider : null,
      sourceContributorId: row.source_contributor_id === null ? null : String(row.source_contributor_id),
      rolesOnGame: jsonArray<GameContribution["role"]>(row.roles_on_game),
    }));
  }

  async findContributorMatches(gameId: string, name: string): Promise<readonly ContributorMatch[]> {
    if (!name.trim()) return [];
    return this.readContributorMatches(this.db, gameId, name);
  }

  async addManualContribution(input: ManualContributionInput | LegacyManualContributionInput): Promise<ManualContributionResult> {
    const manualInput: ManualContributionInput = "kind" in input
      ? input
      : { kind: "new", gameId: input.gameId, name: input.name, entityKind: input.entityKind, role: input.role, allowDuplicate: false };
    try {
      const result = await this.db.transaction(async (tx) => {
        const gameRows = await tx.execute(sql`select id from app_private.games where id = ${manualInput.gameId} for update`) as Row[];
        if (!gameRows[0]) throw new SourcePersistenceFailedError();

        if (manualInput.kind === "new") {
          const name = manualInput.name.trim();
          if (!name) throw new Error("貢獻者名稱不可為空。");
          if (!manualInput.allowDuplicate) {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${normalized(name)}, 0))`);
            const matches = await this.readContributorMatches(tx, manualInput.gameId, name);
            if (matches.length > 0) return { status: "confirmation_required", matches, possibleDuplicate: true } as const;
          }
          const contributorRows = await tx.execute(sql`insert into app_private.contributors (name, entity_kind) values (${name}, ${manualInput.entityKind}) returning id`) as Row[];
          await tx.execute(sql`insert into app_private.manual_contributions (game_id, contributor_id, role) values (${manualInput.gameId}, ${String(contributorRows[0].id)}, ${manualInput.role})`);
          const game = await this.readGame(tx, manualInput.gameId);
          if (!game) throw new SourcePersistenceFailedError();
          return { status: "created", game, possibleDuplicate: false } as const;
        }

        const contributorRows = await tx.execute(sql`select id from app_private.contributors where id = ${manualInput.contributorId} for key share`) as Row[];
        if (!contributorRows[0]) throw new SourcePersistenceFailedError();
        const relationshipRows = await tx.execute(sql`
          select 1 from app_private.games g
          left join app_private.manual_contributions mc on mc.game_id = g.id and mc.contributor_id = ${manualInput.contributorId} and mc.role = ${manualInput.role}
          left join app_private.source_contributions sc on sc.identity_id = g.external_game_identity_id and sc.contributor_id = ${manualInput.contributorId} and sc.role = ${manualInput.role}
          where g.id = ${manualInput.gameId} and (mc.id is not null or sc.id is not null)
          limit 1
        `) as Row[];
        if (relationshipRows[0]) throw new LibraryConflictError("library_contribution_exists", "此貢獻者已在此遊戲擁有相同分類。");
        await tx.execute(sql`insert into app_private.manual_contributions (game_id, contributor_id, role) values (${manualInput.gameId}, ${manualInput.contributorId}, ${manualInput.role})`);
        const game = await this.readGame(tx, manualInput.gameId);
        if (!game) throw new SourcePersistenceFailedError();
        return { status: "created", game, possibleDuplicate: false } as const;
      });
      return result;
    } catch (error) {
      if (error instanceof LibraryConflictError || error instanceof SourcePersistenceFailedError) throw error;
      if (sqlState(error) === "23505") throw new LibraryConflictError("library_contribution_exists", "此貢獻者已在此遊戲擁有相同分類。");
      throw new SourcePersistenceFailedError();
    }
  }

  async removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord> {
    await this.db.execute(sql`delete from app_private.manual_contributions where game_id = ${gameId} and id = ${contributionId}`);
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async deletePlatform(name: string): Promise<void> {
    const rows = await this.db.execute(sql`select p.is_system, count(gp.game_id)::int as usage_count from app_private.platforms p left join app_private.game_platforms gp on gp.platform_id = p.id where p.normalized_name = ${normalized(name)} group by p.id limit 1`) as Row[];
    if (rows[0]?.is_system) throw new LibraryConflictError("library_system_platform", "系統預設平台不可刪除。");
    if (Number(rows[0]?.usage_count ?? 0) > 0) throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此平台，請先移除關係。");
    try { await this.db.execute(sql`delete from app_private.platforms where normalized_name = ${normalized(name)} and is_system = false`); }
    catch (error) { if (sqlState(error) === "23503") throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此平台，請先移除關係。"); throw error; }
  }

  async deleteTag(name: string): Promise<void> {
    const rows = await this.db.execute(sql`select count(gt.game_id)::int as usage_count from app_private.tags t left join app_private.game_tags gt on gt.tag_id = t.id where t.normalized_name = ${normalized(name)} group by t.id limit 1`) as Row[];
    if (Number(rows[0]?.usage_count ?? 0) > 0) throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此標籤，請先移除關係。");
    try { await this.db.execute(sql`delete from app_private.tags where normalized_name = ${normalized(name)}`); }
    catch (error) { if (sqlState(error) === "23503") throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此標籤，請先移除關係。"); throw error; }
  }

  async listPlatforms(): Promise<readonly SharedLibraryItem[]> {
    const rows = await this.db.execute(sql`select p.name, p.is_system, count(g.id)::int as usage_count from app_private.platforms p left join app_private.game_platforms gp on gp.platform_id = p.id left join app_private.games g on g.id = gp.game_id group by p.id order by p.name asc`) as Row[];
    return rows.map((row) => ({ name: String(row.name), usageCount: Number(row.usage_count), isSystem: Boolean(row.is_system) }));
  }

  async listTags(): Promise<readonly SharedLibraryItem[]> {
    const rows = await this.db.execute(sql`select t.name, count(g.id)::int as usage_count from app_private.tags t left join app_private.game_tags gt on gt.tag_id = t.id left join app_private.games g on g.id = gt.game_id group by t.id order by t.name asc`) as Row[];
    return rows.map((row) => ({ name: String(row.name), usageCount: Number(row.usage_count), isSystem: false }));
  }

  async trash(id: string): Promise<void> { await this.db.execute(sql`update app_private.games set trashed_at = now() where id = ${id}`); }
}

import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { GameStore, GameEditInput, LibraryGameQuery, ManualContributionInput, SharedLibraryItem } from "@/modules/games";
import type { ExternalGameRef, GameContribution, GameRecord, Medium, SourceCategory, SourceSnapshot } from "@/modules/games";
import { SourceIdentityConflictError, SourceMediumMismatchError, SourcePersistenceFailedError } from "@/modules/games";
import { beginSourceCoverIngest, isAllowedSourceCoverUrl } from "@/modules/media/internal/source-cover-ingest";
import { LibraryConflictError } from "@/modules/library/internal/errors";

export type QueryExecutor = Readonly<{
  execute(query: SQL): Promise<unknown>;
}>;
export type ProductionExecutor = QueryExecutor & Readonly<{
  transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}>;
type Row = Readonly<Record<string, unknown>>;

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

function sourceContributions(snapshot: SourceSnapshot | null): readonly GameContribution[] {
  return snapshot?.contributors.map((contributor) => ({ id: `source:${snapshot.ref.provider}:${contributor.sourceContributorId}:${contributor.role}`, contributorId: `source:${snapshot.ref.provider}:${contributor.sourceContributorId}`, name: contributor.name, entityKind: contributor.entityKind, role: contributor.role, origin: "source" as const, provider: snapshot.ref.provider, sourceContributorId: contributor.sourceContributorId })) ?? [];
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
    medium: row.medium as Medium,
    displayName: String(row.display_name),
    customDisplayName: row.custom_display_name ? String(row.custom_display_name) : null,
    sourceNames: jsonArray<string>(row.source_names).length > 0 ? jsonArray<string>(row.source_names) : snapshotSourceNames(snapshot),
    aliases: snapshot?.aliases ?? [],
    actualPlatforms: jsonArray<string>(row.actual_platforms),
    tags: jsonArray<string>(row.tags),
    contributors: [...sourceContributions(snapshot), ...manualContributions],
    playerCountNote: row.player_count_note ? String(row.player_count_note) : null,
    coverIngestState: row.cover_ingest_state === "pending" || row.cover_ingest_state === "ready" || row.cover_ingest_state === "failed" ? row.cover_ingest_state : null,
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

  private readonly selectFields = sql`g.id, g.medium, g.display_name, g.player_count_note, g.external_game_identity_id, g.trashed_at, g.created_at, custom_name.name as custom_display_name, i.snapshot,
    coalesce((select jsonb_agg(gn.name order by gn.id) from app_private.game_names gn where gn.game_id = g.id and gn.name_kind in ('source', 'alias')), '[]'::jsonb) as source_names,
    coalesce((select jsonb_agg(p.name order by p.name) from app_private.game_platforms gp join app_private.platforms p on p.id = gp.platform_id where gp.game_id = g.id), '[]'::jsonb) as actual_platforms,
    coalesce((select jsonb_agg(t.name order by t.name) from app_private.game_tags gt join app_private.tags t on t.id = gt.tag_id where gt.game_id = g.id), '[]'::jsonb) as tags,
    bcm.identity_id as metrics_identity_id, bcm.weight as metrics_weight, bcm.strategy_rank as metrics_strategy_rank,
    coalesce((select jsonb_agg(jsonb_build_object('id', mc.id, 'contributorId', c.id, 'name', c.name, 'entityKind', c.entity_kind, 'role', mc.role)) from app_private.manual_contributions mc join app_private.contributors c on c.id = mc.contributor_id where mc.game_id = g.id), '[]'::jsonb) as manual_contributions,
    (select case when mi.original_state = 'failed' or mi.thumbnail_state = 'failed' then 'failed' when mi.original_state = 'ready' and mi.thumbnail_state = 'ready' then 'ready' else 'pending' end from app_private.media_ingests mi where mi.game_id = g.id and mi.source_url = i.snapshot ->> 'coverUrl' limit 1) as cover_ingest_state`;

  private selectFrom(where: SQL) {
    return sql`select ${this.selectFields} from app_private.games g left join app_private.external_game_identities i on i.id = g.external_game_identity_id left join app_private.bgg_current_metrics bcm on bcm.identity_id = i.id and i.provider = 'bgg' left join app_private.game_names custom_name on custom_name.game_id = g.id and custom_name.name_kind = 'custom' ${where}`;
  }

  async list(query = ""): Promise<readonly GameRecord[]> {
    const escaped = query.trim().replace(/[\\%_]/g, "\\$&");
    const needle = `%${escaped}%`;
    const rows = await this.db.execute(this.selectFrom(sql`where g.trashed_at is null and (g.display_name ilike ${needle} escape '\\' or exists (select 1 from app_private.game_names gn where gn.game_id = g.id and gn.name ilike ${needle} escape '\\')) order by g.display_name asc`)) as Row[];
    return rows.map(record);
  }

  async listLibraryGames(query: LibraryGameQuery = {}): Promise<readonly GameRecord[]> {
    const clauses: SQL[] = [sql`g.trashed_at is null`];
    if (query.media?.length) clauses.push(sql`g.medium in (${sql.join(query.media.map((medium) => sql`${medium}`), sql`, `)})`);
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

  async get(id: string): Promise<GameRecord | null> {
    const rows = await this.db.execute(this.selectFrom(sql`where g.id = ${id} limit 1`)) as Row[];
    return rows[0] ? record(rows[0]) : null;
  }

  async createManual(displayName: string, medium: Medium): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const run = async (tx: QueryExecutor) => {
      const rows = await tx.execute(sql`insert into app_private.games (medium, display_name) values (${medium}, ${title}) returning id, medium, display_name, player_count_note, external_game_identity_id, trashed_at, created_at`) as Row[];
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

  private async writeSourceCoverIngest(tx: QueryExecutor, gameId: string, snapshot: SourceSnapshot) {
    if (!snapshot.coverUrl || !isAllowedSourceCoverUrl(snapshot.coverUrl)) return;
    const ingest = beginSourceCoverIngest(gameId, snapshot.coverUrl);
    await tx.execute(sql`insert into app_private.media_ingests (id, game_id, source_url, object_key, original_state, thumbnail_state) values (${ingest.id}, ${gameId}, ${ingest.sourceUrl}, ${ingest.objectKey}, ${ingest.originalState}, ${ingest.thumbnailState}) on conflict (object_key) do update set original_state = case when media_ingests.original_state = 'failed' then 'pending' else media_ingests.original_state end, thumbnail_state = case when media_ingests.thumbnail_state = 'failed' then 'pending' else media_ingests.thumbnail_state end`);
  }

  async createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }> {
    const run = async (tx: QueryExecutor) => {
      const identityRows = await tx.execute(sql`insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb) returning id`) as Row[];
      const identityId = String(identityRows[0].id);
      const gameRows = await tx.execute(sql`insert into app_private.games (medium, display_name, external_game_identity_id) values (${ref.medium}, ${snapshot.title}, ${identityId}) returning id, medium, display_name, player_count_note, external_game_identity_id, trashed_at, created_at`) as Row[];
      const gameId = String(gameRows[0].id);
      await this.writeSourceNames(tx, gameId, snapshot);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceCoverIngest(tx, gameId, snapshot);
      return { game: record({ ...gameRows[0], snapshot, custom_display_name: null, source_names: snapshotSourceNames(snapshot), actual_platforms: [], tags: [], manual_contributions: [] }), created: true };
    };
    try { return await this.db.transaction(run); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        const conflict = await this.db.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} limit 1`) as Row[];
        if (conflict[0]) throw new SourceIdentityConflictError(String(conflict[0].id), Boolean(conflict[0].trashed_at));
      }
      throw error;
    }
  }

  async linkFromSource(gameId: string, ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<GameRecord> {
    const run = async (tx: QueryExecutor) => {
      const gameRows = await tx.execute(sql`select id, medium, external_game_identity_id, trashed_at from app_private.games where id = ${gameId} for update`) as Row[];
      if (!gameRows[0]) throw new SourcePersistenceFailedError();
      if (gameRows[0].external_game_identity_id) throw new SourcePersistenceFailedError();
      if (gameRows[0].medium !== ref.medium) throw new SourceMediumMismatchError();
      const existing = await tx.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} for update`) as Row[];
      if (existing[0]) throw new SourceIdentityConflictError(String(existing[0].id), Boolean(existing[0].trashed_at));
      const identityRows = await tx.execute(sql`insert into app_private.external_game_identities (provider, source_id, medium, snapshot) values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb) returning id`) as Row[];
      const identityId = String(identityRows[0].id);
      await tx.execute(sql`update app_private.games set external_game_identity_id = ${identityId}, display_name = coalesce((select name from app_private.game_names where game_id = ${gameId} and name_kind = 'custom'), ${snapshot.title}) where id = ${gameId}`);
      await this.writeSourceNames(tx, gameId, snapshot);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceCoverIngest(tx, gameId, snapshot);
    };
    try { await this.db.transaction(run); }
    catch (error) {
      if (error instanceof SourceIdentityConflictError || error instanceof SourceMediumMismatchError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        const conflict = await this.db.execute(sql`select g.id, g.trashed_at from app_private.external_game_identities i join app_private.games g on g.external_game_identity_id = i.id where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} limit 1`) as Row[];
        if (conflict[0]) throw new SourceIdentityConflictError(String(conflict[0].id), Boolean(conflict[0].trashed_at));
      }
      throw error;
    }
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async refreshSource(gameId: string, snapshot: SourceSnapshot): Promise<GameRecord> {
    const run = async (tx: QueryExecutor) => {
      const rows = await tx.execute(sql`select g.external_game_identity_id from app_private.games g where g.id = ${gameId} and g.external_game_identity_id is not null for update`) as Row[];
      if (!rows[0]) throw new SourcePersistenceFailedError();
      const identityId = String(rows[0].external_game_identity_id);
      await tx.execute(sql`update app_private.external_game_identities set snapshot = ${JSON.stringify(snapshot)}::jsonb, updated_at = now() where id = ${identityId}`);
      await tx.execute(sql`delete from app_private.external_game_categories where identity_id = ${identityId}`);
      await tx.execute(sql`delete from app_private.source_contributions where identity_id = ${identityId}`);
      await tx.execute(sql`delete from app_private.external_supported_platforms where identity_id = ${identityId}`);
      await this.writeSourceRows(tx, identityId, snapshot);
      await this.writeSourceNames(tx, gameId, snapshot);
      await tx.execute(sql`update app_private.games set display_name = coalesce((select name from app_private.game_names where game_id = ${gameId} and name_kind = 'custom'), ${snapshot.title}) where id = ${gameId}`);
      await this.writeSourceCoverIngest(tx, gameId, snapshot);
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

  async addManualContribution(input: ManualContributionInput) {
    const duplicateRows = await this.db.execute(sql`select 1 from app_private.contributors where lower(name) = lower(${input.name.trim()}) limit 1`) as Row[];
    const run = async (tx: QueryExecutor) => {
      const contributorRows = await tx.execute(sql`insert into app_private.contributors (name, entity_kind) values (${input.name.trim()}, ${input.entityKind}) returning id`) as Row[];
      await tx.execute(sql`insert into app_private.manual_contributions (game_id, contributor_id, role) values (${input.gameId}, ${String(contributorRows[0].id)}, ${input.role})`);
    };
    if (!input.name.trim()) throw new Error("貢獻者名稱不可為空。");
    await this.db.transaction(run);
    const game = await this.get(input.gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return { game, possibleDuplicate: duplicateRows.length > 0 };
  }

  async removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord> {
    await this.db.execute(sql`delete from app_private.manual_contributions where game_id = ${gameId} and id = ${contributionId}`);
    const game = await this.get(gameId);
    if (!game) throw new SourcePersistenceFailedError();
    return game;
  }

  async deletePlatform(name: string): Promise<void> {
    const rows = await this.db.execute(sql`select is_system from app_private.platforms where normalized_name = ${normalized(name)} limit 1`) as Row[];
    if (rows[0]?.is_system) throw new LibraryConflictError("library_system_platform", "系統預設平台不可刪除。");
    try { await this.db.execute(sql`delete from app_private.platforms where normalized_name = ${normalized(name)} and is_system = false`); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "23503") throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此平台，請先移除關係。"); throw error; }
  }

  async deleteTag(name: string): Promise<void> {
    try { await this.db.execute(sql`delete from app_private.tags where normalized_name = ${normalized(name)}`); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "23503") throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此標籤，請先移除關係。"); throw error; }
  }

  async listPlatforms(): Promise<readonly SharedLibraryItem[]> {
    const rows = await this.db.execute(sql`select p.name, p.is_system, count(g.id)::int as usage_count from app_private.platforms p left join app_private.game_platforms gp on gp.platform_id = p.id left join app_private.games g on g.id = gp.game_id and g.trashed_at is null group by p.id order by p.name asc`) as Row[];
    return rows.map((row) => ({ name: String(row.name), usageCount: Number(row.usage_count), isSystem: Boolean(row.is_system) }));
  }

  async listTags(): Promise<readonly SharedLibraryItem[]> {
    const rows = await this.db.execute(sql`select t.name, count(g.id)::int as usage_count from app_private.tags t left join app_private.game_tags gt on gt.tag_id = t.id left join app_private.games g on g.id = gt.game_id and g.trashed_at is null group by t.id order by t.name asc`) as Row[];
    return rows.map((row) => ({ name: String(row.name), usageCount: Number(row.usage_count), isSystem: false }));
  }

  async trash(id: string): Promise<void> { await this.db.execute(sql`update app_private.games set trashed_at = now() where id = ${id}`); }
}

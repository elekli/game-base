import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { GameStore } from "@/modules/games";
import type { ExternalGameRef, GameRecord, Medium, SourceSnapshot } from "@/modules/games";
import { SourceIdentityConflictError } from "@/modules/games";
import { beginSourceCoverIngest } from "@/modules/media/internal/source-cover-ingest";

type Executor = Readonly<{
  execute(query: SQL): Promise<unknown>;
  transaction?<T>(callback: (tx: Executor) => Promise<T>): Promise<T>;
}>;
type Row = Readonly<Record<string, unknown>>;

function record(row: Row): GameRecord {
  return {
    id: String(row.id),
    medium: row.medium as Medium,
    displayName: String(row.display_name),
    externalIdentityId: row.external_game_identity_id ? String(row.external_game_identity_id) : null,
    snapshot: row.snapshot as SourceSnapshot | null,
    trashedAt: row.trashed_at ? String(row.trashed_at) : null,
    createdAt: String(row.created_at),
  };
}

export class PostgresGameStore implements GameStore {
  constructor(private readonly db: Executor) {}

  async list(query = ""): Promise<readonly GameRecord[]> {
    const needle = `%${query.trim()}%`;
    const rows = await this.db.execute(sql`
      select g.id, g.medium, g.display_name, g.external_game_identity_id, g.trashed_at, g.created_at,
             i.snapshot
      from app_private.games g
      left join app_private.external_game_identities i on i.id = g.external_game_identity_id
      where g.trashed_at is null and g.display_name ilike ${needle}
      order by g.display_name asc
    `) as Row[];
    return rows.map(record);
  }

  async get(id: string): Promise<GameRecord | null> {
    const rows = await this.db.execute(sql`
      select g.id, g.medium, g.display_name, g.external_game_identity_id, g.trashed_at, g.created_at,
             i.snapshot
      from app_private.games g
      left join app_private.external_game_identities i on i.id = g.external_game_identity_id
      where g.id = ${id}
      limit 1
    `) as Row[];
    return rows[0] ? record(rows[0]) : null;
  }

  async createManual(displayName: string, medium: Medium): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const rows = await this.db.execute(sql`
      insert into app_private.games (medium, display_name) values (${medium}, ${title})
      returning id, medium, display_name, external_game_identity_id, trashed_at, created_at
    `) as Row[];
    return record(rows[0]);
  }

  async createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }> {
    const existing = await this.db.execute(sql`
      select g.id, g.trashed_at
      from app_private.external_game_identities i
      join app_private.games g on g.external_game_identity_id = i.id
      where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId}
      limit 1
    `) as Row[];
    if (existing[0]) throw new SourceIdentityConflictError(String(existing[0].id), Boolean(existing[0].trashed_at));

    const run = async (tx: Executor) => {
      const identityRows = await tx.execute(sql`
        insert into app_private.external_game_identities (provider, source_id, medium, snapshot)
        values (${ref.provider}, ${ref.sourceId}, ${ref.medium}, ${JSON.stringify(snapshot)}::jsonb)
        returning id
      `) as Row[];
      const identityId = String(identityRows[0].id);
      const gameRows = await tx.execute(sql`
        insert into app_private.games (medium, display_name, external_game_identity_id)
        values (${ref.medium}, ${snapshot.title}, ${identityId})
        returning id, medium, display_name, external_game_identity_id, trashed_at, created_at
      `) as Row[];
      const game = { ...record(gameRows[0]), snapshot };
      if (snapshot.coverUrl) {
        const ingest = beginSourceCoverIngest(game.id, snapshot.coverUrl);
        await tx.execute(sql`
          insert into app_private.media_ingests (id, game_id, source_url, object_key, original_state, thumbnail_state)
          values (${ingest.id}, ${game.id}, ${ingest.sourceUrl}, ${ingest.objectKey}, ${ingest.originalState}, ${ingest.thumbnailState})
          on conflict (object_key) do nothing
        `);
      }
      return { game, created: true };
    };
    try {
      return this.db.transaction ? await this.db.transaction(run) : await run(this.db);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        const conflict = await this.db.execute(sql`
          select g.id, g.trashed_at from app_private.external_game_identities i
          join app_private.games g on g.external_game_identity_id = i.id
          where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} limit 1
        `) as Row[];
        if (conflict[0]) throw new SourceIdentityConflictError(String(conflict[0].id), Boolean(conflict[0].trashed_at));
      }
      throw error;
    }
  }

  async trash(id: string): Promise<void> {
    await this.db.execute(sql`update app_private.games set trashed_at = now() where id = ${id}`);
  }
}

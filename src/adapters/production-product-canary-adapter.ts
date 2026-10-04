import "server-only";

import { sql } from "drizzle-orm";
import type { ProductionExecutor } from "./database-game-store";
import type { GameRecord } from "@/modules/games";

type Row = Readonly<Record<string, unknown>>;

export type ProductionProductCanaryOperation =
  | "note.create" | "note.update" | "note.remove" | "note.restore"
  | "list.create" | "relation.add" | "game.trash" | "game.restore";

export class ProductionProductCanaryAdapter {
  constructor(private readonly db: ProductionExecutor) {}

  async claim(generation: string, ownerId: string) {
    const rows = await this.db.execute(sql`
      select app_private.claim_production_product_canary(${generation}::uuid, ${ownerId}) as claimed
    `) as Row[];
    return rows[0]?.claimed === true;
  }

  async beginCommand(input: Readonly<{
    generation: string;
    ownerId: string;
    commandId: string;
    operation: ProductionProductCanaryOperation;
    targetIds: readonly string[];
  }>) {
    const rows = await this.db.execute(sql`
      select app_private.begin_production_product_canary_command(
        ${input.generation}::uuid, ${input.ownerId}, ${input.commandId}::uuid, ${input.operation}, ${input.targetIds}::uuid[]
      ) as started
    `) as Row[];
    return rows[0]?.started === true;
  }

  async completeCommand(generation: string, commandId: string) {
    const rows = await this.db.execute(sql`
      select app_private.complete_production_product_canary_command(${generation}::uuid, ${commandId}::uuid) as completed
    `) as Row[];
    return rows[0]?.completed === true;
  }

  async requireRecovery(generation: string, commandId: string) {
    const rows = await this.db.execute(sql`
      select app_private.require_production_product_canary_recovery(${generation}::uuid, ${commandId}::uuid) as marked
    `) as Row[];
    return rows[0]?.marked === true;
  }

  async prepareCleanup(generation: string) {
    const rows = await this.db.execute(sql`
      select app_private.prepare_production_product_canary_cleanup(${generation}::uuid) as prepared
    `) as Row[];
    return rows[0]?.prepared === true;
  }

  async cleanup(generation: string) {
    const rows = await this.db.execute(sql`
      select * from app_private.cleanup_production_product_canary(${generation}::uuid)
    `) as Row[];
    if (!rows[0]) throw new Error("production product canary cleanup returned no result");
    return {
      gamesRemoved: Number(rows[0].games_removed),
      notesRemoved: Number(rows[0].notes_removed),
      listsRemoved: Number(rows[0].lists_removed),
      relationsRemoved: Number(rows[0].relations_removed),
    } as const;
  }

  async inspect() {
    const rows = await this.db.execute(sql`
      select * from app_private.inspect_production_product_canary()
    `) as Row[];
    const row = rows[0];
    return row ? {
      phase: String(row.phase),
      generation: String(row.generation),
      commandId: row.command_id === null ? null : String(row.command_id),
      deadlineAt: row.deadline_at === null ? null : new Date(String(row.deadline_at)).toISOString(),
      gameCount: Number(row.game_count),
      noteCount: Number(row.note_count),
    } : null;
  }

  async gamesForOwner(generation: string, ownerId: string): Promise<readonly GameRecord[]> {
    const rows = await this.db.execute(sql`
      select * from app_private.list_production_product_canary_games(${generation}::uuid, ${ownerId})
    `) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      version: Number(row.version),
      medium: row.medium === "video_game" ? "video_game" : "board_game",
      displayName: String(row.display_name),
      customDisplayName: null,
      sourceNames: [],
      aliases: [],
      actualPlatforms: [],
      tags: [],
      contributors: [],
      playerCountNote: null,
      coverIngestState: null,
      coverAssetId: null,
      coverThumbnailState: null,
      trashedAt: row.trashed_at === null ? null : String(row.trashed_at),
      externalIdentityId: null,
      snapshot: null,
      createdAt: String(row.created_at),
    }));
  }
}

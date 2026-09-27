import "server-only";
import { sql } from "drizzle-orm";
import type { ExternalGameRef } from "@/modules/games/internal/types";
import type { ExternalThumbnailClaim, ExternalThumbnailStore } from "@/modules/lists/external-reference-thumbnail";
import type { ProductionExecutor } from "./database-game-store";

type Row = Readonly<Record<string, unknown>>;

export class PostgresExternalThumbnailStore implements ExternalThumbnailStore {
  constructor(private readonly db: ProductionExecutor) {}

  claim(ref: ExternalGameRef, lease: Readonly<{ token: string; until: string }>): Promise<ExternalThumbnailClaim> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select r.external_game_identity_id, r.thumbnail_state, r.thumbnail_lease_until > clock_timestamp() as lease_active
        from app_private.external_game_references r
        join app_private.external_game_identities i on i.id = r.external_game_identity_id
        where i.provider = ${ref.provider} and i.source_id = ${ref.sourceId} and i.medium = ${ref.medium}
        for update of r
      `) as Row[];
      const row = rows[0];
      if (!row) return { status: "not_found" };
      if (row.thumbnail_state === "ready") return { status: "ready" };
      if (row.thumbnail_state === "pending" && row.lease_active === true) return { status: "busy" };
      const claimed = await tx.execute(sql`
        update app_private.external_game_references
        set thumbnail_state = 'pending', thumbnail_object_key = null,
            thumbnail_lease_token = ${lease.token}, thumbnail_lease_until = ${lease.until},
            version = version + 1, updated_at = clock_timestamp()
        where external_game_identity_id = ${String(row.external_game_identity_id)}
        returning external_game_identity_id
      `) as Row[];
      return { status: "claimed", identityId: String(claimed[0]!.external_game_identity_id), leaseToken: lease.token };
    });
  }

  async complete(identityId: string, leaseToken: string, objectKey: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      update app_private.external_game_references
      set thumbnail_state = 'ready', thumbnail_object_key = ${objectKey},
          thumbnail_lease_token = null, thumbnail_lease_until = null,
          version = version + 1, updated_at = clock_timestamp()
      where external_game_identity_id = ${identityId} and thumbnail_state = 'pending'
        and thumbnail_lease_token = ${leaseToken} and thumbnail_lease_until > clock_timestamp()
      returning external_game_identity_id
    `) as Row[];
    return rows.length === 1;
  }

  async fail(identityId: string, leaseToken: string): Promise<void> {
    await this.db.execute(sql`
      update app_private.external_game_references
      set thumbnail_state = 'failed', thumbnail_object_key = null,
          thumbnail_lease_token = null, thumbnail_lease_until = null,
          version = version + 1, updated_at = clock_timestamp()
      where external_game_identity_id = ${identityId} and thumbnail_state = 'pending'
        and thumbnail_lease_token = ${leaseToken}
    `);
  }
}

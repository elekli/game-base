import "server-only";
import { sql } from "drizzle-orm";
import type { ProductionExecutor, QueryExecutor } from "./database-game-store";
import {
  MEDIA_THUMBNAIL_SPEC,
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
  type BeginMediaRecord,
  type BeginMediaUploadCommand,
  type FinalizeClaim,
  type MediaAsset,
  type MediaDerivative,
  type MediaIngest,
  type MediaPurpose,
  type MediaStore,
  type MediaUploadResult,
  type ValidatedMediaObject,
} from "@/modules/media";

type Row = Readonly<Record<string, unknown>>;

function ingestFrom(row: Row): MediaIngest {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    reservedAssetId: String(row.reserved_asset_id),
    gameId: String(row.game_id),
    purpose: row.purpose as MediaPurpose,
    originalObjectPath: String(row.original_object_path),
    originalFileName: String(row.original_file_name),
    declaredMimeType: String(row.declared_mime_type),
    declaredByteSize: Number(row.declared_byte_size),
    state: row.state as MediaIngest["state"],
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseUntil: row.lease_until === null ? null : new Date(String(row.lease_until)).toISOString(),
    staleAfter: new Date(String(row.stale_after)).toISOString(),
  };
}

function sameCommand(ingest: MediaIngest, command: BeginMediaUploadCommand): boolean {
  return ingest.gameId === command.gameId && ingest.purpose === command.purpose && ingest.originalFileName === command.originalFileName && ingest.declaredMimeType === command.declaredMimeType && ingest.declaredByteSize === command.declaredByteSize;
}

function assetFrom(row: Row): MediaAsset {
  return {
    id: String(row.asset_id),
    ingestId: String(row.ingest_id),
    gameId: String(row.game_id),
    purpose: row.purpose as MediaPurpose,
    originalObjectPath: String(row.original_object_path),
    originalFileName: String(row.original_file_name),
    actualMimeType: String(row.actual_mime_type),
    byteSize: Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    removedAt: row.removed_at === null ? null : new Date(String(row.removed_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

async function readResult(executor: QueryExecutor, ingestId: string): Promise<MediaUploadResult | null> {
  const rows = await executor.execute(sql`
    select asset.id as asset_id, asset.ingest_id, asset.game_id, asset.purpose,
      asset.original_object_path, asset.original_file_name, asset.actual_mime_type,
      asset.byte_size, asset.width, asset.height, asset.removed_at, asset.created_at,
      derivative.spec, derivative.state as derivative_state
    from app_private.media_assets asset
    join app_private.media_ingests authoritative_ingest
      on authoritative_ingest.id = asset.ingest_id and authoritative_ingest.state = 'finalized'
    left join app_private.media_derivatives derivative on derivative.asset_id = asset.id
    where asset.ingest_id = ${ingestId} and asset.authority_state = 'verified'
    limit 1
  `) as Row[];
  if (!rows[0]) return null;
  const thumbnail: MediaDerivative | null = rows[0].spec === null || rows[0].spec === undefined ? null : {
    assetId: String(rows[0].asset_id),
    spec: MEDIA_THUMBNAIL_SPEC,
    state: rows[0].derivative_state as MediaDerivative["state"],
  };
  return { asset: assetFrom(rows[0]), thumbnail };
}

const ingestFields = sql`id, idempotency_key, reserved_asset_id, game_id, purpose, original_object_path,
  original_file_name, declared_mime_type, declared_byte_size, state, lease_token, lease_until, stale_after`;

export class PostgresMediaStore implements MediaStore {
  constructor(private readonly db: ProductionExecutor) {}

  async begin(command: BeginMediaUploadCommand, reserved: Readonly<{ ingestId: string; assetId: string; objectPath: string; staleAfter: string }>): Promise<BeginMediaRecord> {
    return this.db.transaction(async (tx) => {
      const games = await tx.execute(sql`select id from app_private.games where id = ${command.gameId} and trashed_at is null for key share`) as Row[];
      if (!games[0]) throw new MediaGameUnavailableError();
      const inserted = await tx.execute(sql`
        insert into app_private.media_ingests (
          id, idempotency_key, reserved_asset_id, channel, purpose, game_id,
          original_object_path, original_file_name, declared_mime_type, declared_byte_size,
          state, stale_after, source_url, object_key, original_state, thumbnail_state
        ) values (
          ${reserved.ingestId}, ${command.idempotencyKey}, ${reserved.assetId}, 'browser_tus', ${command.purpose}, ${command.gameId},
          ${reserved.objectPath}, ${command.originalFileName}, ${command.declaredMimeType}, ${command.declaredByteSize},
          'issued', ${reserved.staleAfter}, '', ${reserved.objectPath}, 'pending', 'pending'
        ) on conflict (idempotency_key) do nothing
        returning ${ingestFields}
      `) as Row[];
      const rows = inserted[0] ? inserted : await tx.execute(sql`select ${ingestFields} from app_private.media_ingests where idempotency_key = ${command.idempotencyKey}`) as Row[];
      const ingest = ingestFrom(rows[0]);
      if (!sameCommand(ingest, command)) throw new MediaUploadIdempotencyConflictError();
      if (ingest.state === "finalized") {
        const result = await readResult(tx, ingest.id);
        if (!result) throw new MediaFinalizeUnavailableError();
        return { status: "already_finalized", result };
      }
      if (ingest.state === "finalizing") return { status: "finalizing" };
      if (ingest.state !== "issued") throw new MediaFinalizeUnavailableError();
      return { status: "grantable", ingest, created: Boolean(inserted[0]) };
    });
  }

  async renewGrant(idempotencyKey: string, objectPath: string, staleAfter: string): Promise<void> {
    const rows = await this.db.execute(sql`update app_private.media_ingests set stale_after = ${staleAfter} where idempotency_key = ${idempotencyKey} and original_object_path = ${objectPath} and state = 'issued' returning id`) as Row[];
    if (!rows[0]) throw new MediaFinalizeUnavailableError();
  }

  async claimFinalize(idempotencyKey: string, lease: Readonly<{ token: string; until: string }>): Promise<FinalizeClaim> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`select ${ingestFields}, lease_until > now() as lease_valid, stale_after > now() as reservation_valid from app_private.media_ingests where idempotency_key = ${idempotencyKey} for update`) as Row[];
      if (!rows[0]) throw new MediaFinalizeUnavailableError();
      const ingest = ingestFrom(rows[0]);
      if (ingest.state === "finalized") {
        const result = await readResult(tx, ingest.id);
        if (!result) throw new MediaFinalizeUnavailableError();
        return { status: "already_finalized", result };
      }
      if (ingest.state === "cleanup_pending" || ingest.state === "expired") throw new MediaFinalizeUnavailableError();
      if (ingest.state === "issued" && rows[0].reservation_valid !== true) throw new MediaFinalizeUnavailableError();
      if (ingest.state === "finalizing" && rows[0].lease_valid === true) throw new MediaFinalizeUnavailableError();
      const claimedRows = await tx.execute(sql`
        update app_private.media_ingests
        set state = 'finalizing', lease_token = ${lease.token}, lease_until = ${lease.until}, last_error_code = null
        where id = ${ingest.id} and (state <> 'issued' or stale_after > now())
        returning ${ingestFields}
      `) as Row[];
      if (!claimedRows[0]) throw new MediaFinalizeUnavailableError();
      return { status: "claimed", ingest: ingestFrom(claimedRows[0]) };
    });
  }

  async releaseIncomplete(idempotencyKey: string, leaseToken: string): Promise<void> {
    await this.db.execute(sql`
      update app_private.media_ingests
      set state = 'issued', lease_token = null, lease_until = null, last_error_code = 'media_upload_incomplete'
      where idempotency_key = ${idempotencyKey} and state = 'finalizing' and lease_token = ${leaseToken}
    `);
  }

  async rejectInvalid(idempotencyKey: string, leaseToken: string): Promise<void> {
    await this.db.execute(sql`
      update app_private.media_ingests
      set state = 'cleanup_pending', lease_token = null, lease_until = null,
        last_error_code = 'media_stored_object_invalid', original_state = 'failed'
      where idempotency_key = ${idempotencyKey} and state = 'finalizing' and lease_token = ${leaseToken}
    `);
  }

  async completeFinalize(idempotencyKey: string, leaseToken: string, object: ValidatedMediaObject): Promise<MediaUploadResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`select ${ingestFields}, lease_until > now() as lease_valid from app_private.media_ingests where idempotency_key = ${idempotencyKey} for update`) as Row[];
      if (!rows[0]) throw new MediaFinalizeUnavailableError();
      const ingest = ingestFrom(rows[0]);
      if (ingest.state === "finalized") {
        const existing = await readResult(tx, ingest.id);
        if (!existing) throw new MediaFinalizeUnavailableError();
        return existing;
      }
      if (ingest.state !== "finalizing" || ingest.leaseToken !== leaseToken || rows[0].lease_valid !== true) throw new MediaFinalizeUnavailableError();
      await tx.execute(sql`
        update app_private.media_ingests
        set actual_mime_type = ${object.actualMimeType}, actual_byte_size = ${object.byteSize},
          image_width = ${object.width}, image_height = ${object.height}
        where id = ${ingest.id}
      `);
      await tx.execute(sql`set constraints app_private.media_assets_valid_references deferred`);
      await tx.execute(sql`
        insert into app_private.media_assets (
          id, ingest_id, game_id, purpose, original_object_path, original_file_name,
          actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type
        ) values (
          ${ingest.reservedAssetId}, ${ingest.id}, ${ingest.gameId}, ${ingest.purpose}, ${ingest.originalObjectPath},
          ${ingest.originalFileName}, ${object.actualMimeType}, ${object.byteSize}, ${object.width}, ${object.height}, 'verified',
          ${ingest.purpose}, ${ingest.originalObjectPath}, ${object.actualMimeType}
        ) on conflict (ingest_id) do nothing
      `);
      if (ingest.purpose !== "attachment") {
        await tx.execute(sql`
          insert into app_private.media_derivatives (asset_id, spec, authority_state, state, kind)
          values (${ingest.reservedAssetId}, ${MEDIA_THUMBNAIL_SPEC}, 'verified', 'pending', 'thumbnail_webp')
          on conflict (asset_id, spec) do nothing
        `);
      }
      if (ingest.purpose === "custom_cover") {
        await tx.execute(sql`update app_private.games set manual_cover_asset_id = ${ingest.reservedAssetId} where id = ${ingest.gameId}`);
      }
      await tx.execute(sql`
        update app_private.media_ingests
        set state = 'finalized', lease_token = null, lease_until = null, finalized_at = now(),
          actual_mime_type = ${object.actualMimeType}, actual_byte_size = ${object.byteSize},
          image_width = ${object.width}, image_height = ${object.height}, last_error_code = null,
          original_state = 'ready', thumbnail_state = ${ingest.purpose === "attachment" ? "ready" : "pending"}
        where id = ${ingest.id}
      `);
      const result = await readResult(tx, ingest.id);
      if (!result) throw new MediaFinalizeUnavailableError();
      return result;
    });
  }
}

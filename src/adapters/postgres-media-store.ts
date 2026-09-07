import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ProductionExecutor, QueryExecutor } from "./database-game-store";
import {
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
  type BeginMediaUploadCommand,
  type MediaAsset,
  type MediaDerivative,
  type MediaPurpose,
  type StoredMediaPurpose,
  type MediaUploadResult,
} from "@/modules/media";
import { matchesUploadCommand } from "@/modules/media/internal/matches-upload-command";
import {
  MEDIA_THUMBNAIL_SPEC,
  type BeginMediaRecord,
  type FinalizeClaim,
  type MediaIngest,
  type MediaStore,
  type ValidatedMediaObject,
} from "@/modules/media/internal/types";
import { decideThumbnailFailure } from "@/modules/media/internal/thumbnail-state";

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

function assetFrom(row: Row): MediaAsset {
  return {
    id: String(row.asset_id),
    gameId: String(row.game_id),
    purpose: row.purpose as StoredMediaPurpose,
    originalFileName: String(row.original_file_name),
    actualMimeType: String(row.actual_mime_type),
    byteSize: Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    removedAt: row.removed_at === null ? null : new Date(String(row.removed_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    caption: row.caption === null || row.caption === undefined ? null : String(row.caption),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
  };
}

async function readResult(executor: QueryExecutor, ingestId: string): Promise<MediaUploadResult | null> {
  const rows = await executor.execute(sql`
    select asset.id as asset_id, asset.ingest_id, asset.game_id, asset.purpose,
      asset.original_object_path, asset.original_file_name, asset.actual_mime_type,
      asset.byte_size, asset.width, asset.height, asset.removed_at, asset.created_at,
      asset.caption, asset.display_name, asset.description,
      derivative.spec, derivative.state as derivative_state
    from app_private.media_assets asset
    join app_private.media_ingests authoritative_ingest
      on authoritative_ingest.id = asset.ingest_id and authoritative_ingest.state = 'finalized'
    left join app_private.media_derivatives derivative
      on derivative.asset_id = asset.id
      and derivative.authority_state = 'verified'
      and derivative.spec = ${MEDIA_THUMBNAIL_SPEC}
    where asset.ingest_id = ${ingestId} and asset.authority_state = 'verified'
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
      const games = await tx.execute(sql`select id from app_private.games where id = ${command.gameId} and trashed_at is null for update`) as Row[];
      if (!games[0]) throw new MediaGameUnavailableError();
      const operation = await tx.execute(sql`
        insert into app_private.media_ingest_operations (
          idempotency_key, ingest_id, reserved_asset_id, game_id, purpose,
          original_object_path, original_file_name, declared_mime_type, declared_byte_size
        ) values (
          ${command.idempotencyKey}, ${reserved.ingestId}, ${reserved.assetId}, ${command.gameId}, ${command.purpose},
          ${reserved.objectPath}, ${command.originalFileName}, ${command.declaredMimeType}, ${command.declaredByteSize}
        ) on conflict (idempotency_key) do nothing
        returning ingest_id
      `) as Row[];
      const inserted = operation[0] ? await tx.execute(sql`
        insert into app_private.media_ingests (
          id, idempotency_key, reserved_asset_id, channel, purpose, game_id,
          original_object_path, original_file_name, declared_mime_type, declared_byte_size,
          state, stale_after, source_url, object_key, original_state, thumbnail_state, created_at
        ) values (
          ${reserved.ingestId}, ${command.idempotencyKey}, ${reserved.assetId}, 'browser_tus', ${command.purpose}, ${command.gameId},
          ${reserved.objectPath}, ${command.originalFileName}, ${command.declaredMimeType}, ${command.declaredByteSize},
          'issued', ${reserved.staleAfter}, '', ${reserved.objectPath}, 'pending', 'pending', clock_timestamp()
        )
        returning ${ingestFields}, created_at
      `) as Row[] : [];
      const rows = inserted[0] ? inserted : await tx.execute(sql`
        select ${ingestFields}
        from app_private.media_ingests
        where id = (select ingest_id from app_private.media_ingest_operations where idempotency_key = ${command.idempotencyKey})
      `) as Row[];
      const ingest = ingestFrom(rows[0]);
      if (!matchesUploadCommand(ingest, command)) throw new MediaUploadIdempotencyConflictError();
      if (inserted[0] && command.purpose === "custom_cover") {
        await tx.execute(sql`
          update app_private.games
          set manual_cover_selected_at = ${inserted[0].created_at}
          where id = ${command.gameId}
        `);
      }
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
      if (ingest.state === "finalizing" && rows[0].lease_valid === true) return { status: "finalizing" };
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
    const rows = await this.db.execute(sql`
      update app_private.media_ingests
      set state = 'issued', lease_token = null, lease_until = null, last_error_code = 'media_upload_incomplete'
      where idempotency_key = ${idempotencyKey} and state = 'finalizing' and lease_token = ${leaseToken} and lease_until > now()
      returning id
    `) as Row[];
    if (!rows[0]) throw new MediaFinalizeUnavailableError();
  }

  async rejectInvalid(idempotencyKey: string, leaseToken: string): Promise<void> {
    const rows = await this.db.execute(sql`
      update app_private.media_ingests
      set state = 'cleanup_pending', lease_token = null, lease_until = null,
        last_error_code = 'media_stored_object_invalid', original_state = 'failed'
      where idempotency_key = ${idempotencyKey} and state = 'finalizing' and lease_token = ${leaseToken} and lease_until > now()
      returning id
    `) as Row[];
    if (!rows[0]) throw new MediaFinalizeUnavailableError();
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
          'user_cover', ${ingest.originalObjectPath}, ${object.actualMimeType}
        ) on conflict (ingest_id) do nothing
      `);
      if (ingest.purpose !== "attachment") {
        await tx.execute(sql`
          insert into app_private.media_derivatives (asset_id, spec, authority_state, state, kind, object_key)
          values (${ingest.reservedAssetId}, ${MEDIA_THUMBNAIL_SPEC}, 'verified', 'pending', 'thumbnail_webp', ${`pending:${ingest.reservedAssetId}`})
          on conflict (asset_id, kind) do nothing
        `);
      }
      if (ingest.purpose === "custom_cover") {
        await tx.execute(sql`
          update app_private.games
          set manual_cover_asset_id = ${ingest.reservedAssetId}, manual_cover_selected_at = (
            select created_at from app_private.media_ingests where id = ${ingest.id}
          )
          where id = ${ingest.gameId}
            and manual_cover_selected_at = (
              select created_at from app_private.media_ingests where id = ${ingest.id}
            )
        `);
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

  async findReadableOriginal(assetId: string): Promise<Readonly<{ path: string; fileName: string; purpose: StoredMediaPurpose; actualMimeType: string }> | null> {
    const rows = await this.db.execute(sql`
      select asset.original_object_path, asset.original_file_name, asset.purpose, asset.actual_mime_type
      from app_private.media_assets asset
      join app_private.media_ingests ingest on ingest.id = asset.ingest_id
      join app_private.games game on game.id = asset.game_id
      where asset.id = ${assetId}
        and asset.authority_state = 'verified'
        and asset.removed_at is null
        and asset.superseded_at is null
        and ingest.state = 'finalized'
        and game.trashed_at is null
      limit 1
    `) as Row[];
    return rows[0] ? {
      path: String(rows[0].original_object_path), fileName: String(rows[0].original_file_name),
      purpose: rows[0].purpose as StoredMediaPurpose, actualMimeType: String(rows[0].actual_mime_type),
    } : null;
  }

  async findReadableThumbnail(assetId: string): Promise<Readonly<{ path: string }> | null> {
    const rows = await this.db.execute(sql`
      select derivative.current_object_path
      from app_private.media_derivatives derivative
      join app_private.media_assets asset on asset.id = derivative.asset_id
      join app_private.media_ingests ingest on ingest.id = asset.ingest_id
      join app_private.games game on game.id = asset.game_id
      where asset.id = ${assetId}
        and asset.authority_state = 'verified' and asset.removed_at is null and asset.superseded_at is null
        and asset.purpose <> 'attachment' and ingest.state = 'finalized' and game.trashed_at is null
        and derivative.authority_state = 'verified' and derivative.spec = ${MEDIA_THUMBNAIL_SPEC}
        and derivative.state = 'ready' and derivative.current_object_path is not null
      limit 1
    `) as Row[];
    return rows[0] ? { path: String(rows[0].current_object_path) } : null;
  }

  async claimThumbnail(assetId: string, lease: Readonly<{ token: string; durationMs?: number }>) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select derivative.id as derivative_id, derivative.state, derivative.attempt_count, derivative.cycle_attempt_count,
          derivative.lease_until, derivative.next_attempt_at,
          asset.original_object_path
        from app_private.media_derivatives derivative
        join app_private.media_assets asset on asset.id = derivative.asset_id
        join app_private.media_ingests ingest on ingest.id = asset.ingest_id and ingest.state = 'finalized'
        where derivative.asset_id = ${assetId} and derivative.authority_state = 'verified'
          and derivative.spec = ${MEDIA_THUMBNAIL_SPEC} and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
        for update
      `) as Row[];
      const derivative = rows[0];
      if (!derivative) return { status: "not_found" as const };
      const timing = await tx.execute(sql`
        select lease_until > clock_timestamp() as lease_valid,
          (next_attempt_at is null or next_attempt_at <= clock_timestamp()) as retry_due
        from app_private.media_derivatives where id = ${String(derivative.derivative_id)}
      `) as Row[];
      if (!timing[0]) throw new MediaFinalizeUnavailableError();
      if (derivative.state === "ready" || derivative.state === "failed") return { status: "not_ready" as const };
      if (derivative.state === "pending" && timing[0].retry_due !== true) return { status: "not_ready" as const };
      if (derivative.state === "processing" && timing[0].lease_valid === true) return { status: "busy" as const };
      const cycleAttemptCount = Number(derivative.cycle_attempt_count);
      if (cycleAttemptCount >= 3) {
        await tx.execute(sql`
          update app_private.media_derivatives
          set state = 'failed', lease_token = null, lease_until = null, active_attempt_id = null,
            next_attempt_at = null, last_error_code = 'media_thumbnail_retry_exhausted'
          where id = ${String(derivative.derivative_id)}
        `);
        return { status: "not_ready" as const };
      }
      const attemptNumber = Number(derivative.attempt_count) + 1;
      const attemptId = randomUUID();
      const objectPath = `thumbnails/${assetId}/${MEDIA_THUMBNAIL_SPEC}/${attemptNumber}-${attemptId}.webp`;
      const attempts = await tx.execute(sql`
        insert into app_private.media_derivative_attempts (id, derivative_id, attempt_number, retry_cycle, object_path, state)
        values (${attemptId}, ${String(derivative.derivative_id)}, ${attemptNumber},
          (select retry_cycle from app_private.media_derivatives where id = ${String(derivative.derivative_id)}), ${objectPath}, 'reserved')
        returning id
      `) as Row[];
      if (!attempts[0]) throw new MediaFinalizeUnavailableError();
      await tx.execute(sql`
        update app_private.media_derivatives
        set state = 'processing', attempt_count = ${attemptNumber}, cycle_attempt_count = ${cycleAttemptCount + 1},
          active_attempt_id = ${attemptId}, lease_token = ${lease.token},
          lease_until = clock_timestamp() + least(greatest(${lease.durationMs ?? 300_000}, 1), 300000) * interval '1 millisecond',
          next_attempt_at = null, last_error_code = null
        where id = ${String(derivative.derivative_id)}
      `);
      return {
        status: "claimed" as const,
        derivativeId: String(derivative.derivative_id),
        assetId,
        originalObjectPath: String(derivative.original_object_path),
        attempt: { id: attemptId, number: attemptNumber, objectPath, cycleAttemptCount: cycleAttemptCount + 1 },
      };
    });
  }

  async markThumbnailUploaded(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const derivatives = await tx.execute(sql`
        select id from app_private.media_derivatives
        where id = ${claim.derivativeId} and state = 'processing' and active_attempt_id = ${claim.attemptId}
          and attempt_count = ${claim.attemptNumber} and lease_token = ${claim.leaseToken}
        for update
      `) as Row[];
      if (!derivatives[0]) throw new MediaFinalizeUnavailableError();
      const timing = await tx.execute(sql`
        select lease_until > clock_timestamp() as lease_valid
        from app_private.media_derivatives where id = ${claim.derivativeId}
      `) as Row[];
      if (timing[0]?.lease_valid !== true) throw new MediaFinalizeUnavailableError();
      const attempts = await tx.execute(sql`
        update app_private.media_derivative_attempts set state = 'uploaded', uploaded_at = clock_timestamp()
        where id = ${claim.attemptId} and derivative_id = ${claim.derivativeId}
          and attempt_number = ${claim.attemptNumber} and state = 'reserved'
        returning id
      `) as Row[];
      if (!attempts[0]) throw new MediaFinalizeUnavailableError();
    });
  }

  async adoptThumbnail(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string; width: number; height: number; byteSize: number }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const derivatives = await tx.execute(sql`
        select id from app_private.media_derivatives
        where id = ${claim.derivativeId} and state = 'processing' and active_attempt_id = ${claim.attemptId}
          and attempt_count = ${claim.attemptNumber} and lease_token = ${claim.leaseToken}
        for update
      `) as Row[];
      if (!derivatives[0]) throw new MediaFinalizeUnavailableError();
      const timing = await tx.execute(sql`
        select lease_until > clock_timestamp() as lease_valid
        from app_private.media_derivatives where id = ${claim.derivativeId}
      `) as Row[];
      if (timing[0]?.lease_valid !== true) throw new MediaFinalizeUnavailableError();
      const attempts = await tx.execute(sql`
        update app_private.media_derivative_attempts set state = 'adopted'
        where id = ${claim.attemptId} and derivative_id = ${claim.derivativeId}
          and attempt_number = ${claim.attemptNumber} and state = 'uploaded'
        returning object_path
      `) as Row[];
      if (!attempts[0]) throw new MediaFinalizeUnavailableError();
      await tx.execute(sql`
        update app_private.media_derivatives
        set state = 'ready', active_attempt_id = null, adopted_attempt_id = ${claim.attemptId},
          lease_token = null, lease_until = null, current_object_path = ${String(attempts[0].object_path)},
          object_key = ${String(attempts[0].object_path)}, width = ${claim.width}, height = ${claim.height},
          byte_size = ${claim.byteSize}, completed_at = clock_timestamp(), next_attempt_at = null, last_error_code = null
        where id = ${claim.derivativeId}
      `);
    });
  }

  async failThumbnail(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string; deterministic: boolean }>): Promise<Readonly<{ retryDelayMs: number | null }>> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select cycle_attempt_count from app_private.media_derivatives
        where id = ${claim.derivativeId} and state = 'processing' and active_attempt_id = ${claim.attemptId}
          and attempt_count = ${claim.attemptNumber} and lease_token = ${claim.leaseToken}
        for update
      `) as Row[];
      if (!rows[0]) throw new MediaFinalizeUnavailableError();
      const timing = await tx.execute(sql`
        select lease_until > clock_timestamp() as lease_valid
        from app_private.media_derivatives where id = ${claim.derivativeId}
      `) as Row[];
      if (timing[0]?.lease_valid !== true) throw new MediaFinalizeUnavailableError();
      const outcome = decideThumbnailFailure({ cycleAttemptCount: Number(rows[0].cycle_attempt_count), deterministic: claim.deterministic });
      await tx.execute(sql`
        update app_private.media_derivatives
        set state = ${outcome.state}, active_attempt_id = null, lease_token = null, lease_until = null,
          next_attempt_at = ${outcome.retryDelayMs === null ? null : sql`clock_timestamp() + ${outcome.retryDelayMs} * interval '1 millisecond'`},
          last_error_code = ${claim.deterministic ? "media_thumbnail_unsupported" : "media_thumbnail_unavailable"}
        where id = ${claim.derivativeId}
      `);
      return { retryDelayMs: outcome.retryDelayMs };
    });
  }

  async retryThumbnail(assetId: string): Promise<MediaUploadResult["thumbnail"]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select derivative.id from app_private.media_derivatives derivative
        join app_private.media_assets asset on asset.id = derivative.asset_id
        join app_private.media_ingests ingest on ingest.id = asset.ingest_id and ingest.state = 'finalized'
        where derivative.asset_id = ${assetId} and derivative.authority_state = 'verified'
          and derivative.spec = ${MEDIA_THUMBNAIL_SPEC} and derivative.state = 'failed'
          and asset.authority_state = 'verified' and asset.purpose <> 'attachment'
        for update
      `) as Row[];
      if (!rows[0]) throw new MediaFinalizeUnavailableError();
      await tx.execute(sql`
        update app_private.media_derivatives
        set state = 'pending', retry_cycle = retry_cycle + 1, cycle_attempt_count = 0,
          active_attempt_id = null, lease_token = null, lease_until = null, next_attempt_at = clock_timestamp(), last_error_code = null
        where id = ${String(rows[0].id)}
      `);
      return { assetId, spec: MEDIA_THUMBNAIL_SPEC, state: "pending" as const };
    });
  }

  async listGameMedia(gameId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      const games = await tx.execute(sql`
        select game.manual_cover_asset_id, identity.source_cover_asset_id
        from app_private.games game
        left join app_private.external_game_identities identity on identity.id = game.external_game_identity_id
        where game.id = ${gameId} and game.trashed_at is null
      `) as Row[];
      if (!games[0]) throw new MediaGameUnavailableError();
      const rows = await tx.execute(sql`
        select asset.id as asset_id, asset.game_id, asset.purpose, asset.original_file_name,
          asset.actual_mime_type, asset.byte_size, asset.width, asset.height, asset.removed_at,
          asset.created_at, asset.caption, asset.display_name, asset.description,
          derivative.spec, derivative.state as derivative_state, derivative.current_object_path
        from app_private.media_assets asset
        join app_private.media_ingests ingest on ingest.id = asset.ingest_id and ingest.state = 'finalized'
        left join app_private.media_derivatives derivative on derivative.asset_id = asset.id
          and derivative.authority_state = 'verified' and derivative.spec = ${MEDIA_THUMBNAIL_SPEC}
        where asset.game_id = ${gameId} and asset.authority_state = 'verified'
          and asset.removed_at is null and asset.superseded_at is null
        order by asset.created_at desc, asset.id
      `) as Row[];
      const mapped = rows.map((row) => ({
        asset: assetFrom(row),
        thumbnail: row.spec === null || row.spec === undefined ? null : {
          assetId: String(row.asset_id), spec: MEDIA_THUMBNAIL_SPEC,
          state: row.derivative_state as MediaDerivative["state"],
        },
        thumbnailPath: row.derivative_state === "ready" && row.current_object_path ? String(row.current_object_path) : null,
      }));
      const sourceId = games[0].source_cover_asset_id === null ? null : String(games[0].source_cover_asset_id);
      return {
        manualCoverAssetId: games[0].manual_cover_asset_id === null ? null : String(games[0].manual_cover_asset_id),
        sourceCover: sourceId ? mapped.find((item) => item.asset.id === sourceId) ?? null : null,
        items: mapped.filter((item) => item.asset.id !== sourceId),
      };
    });
  }

  async updateMediaMetadata(command: Readonly<{ assetId: string; caption?: string | null; displayName?: string | null; description?: string | null }>): Promise<MediaAsset | null> {
    const clean = (value: string | null | undefined) => value === undefined ? undefined : value?.trim() || null;
    const caption = clean(command.caption);
    const displayName = clean(command.displayName);
    const description = clean(command.description);
    const rows = await this.db.execute(sql`
      update app_private.media_assets
      set caption = case when ${caption === undefined} then caption else ${caption ?? null} end,
        display_name = case when ${displayName === undefined} then display_name else ${displayName ?? null} end,
        description = case when ${description === undefined} then description else ${description ?? null} end
      where id = ${command.assetId} and authority_state = 'verified' and removed_at is null
        and purpose in ('gallery_image', 'attachment')
      returning id as asset_id, game_id, purpose, original_file_name, actual_mime_type,
        byte_size, width, height, removed_at, created_at, caption, display_name, description
    `) as Row[];
    return rows[0] ? assetFrom(rows[0]) : null;
  }

  async selectManualCover(gameId: string, assetId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      update app_private.games game
      set manual_cover_asset_id = asset.id, manual_cover_selected_at = clock_timestamp()
      from app_private.media_assets asset
      where game.id = ${gameId} and game.trashed_at is null and asset.id = ${assetId}
        and asset.game_id = game.id and asset.authority_state = 'verified'
        and asset.removed_at is null and asset.superseded_at is null
        and asset.purpose in ('gallery_image', 'custom_cover')
      returning game.id
    `) as Row[];
    return Boolean(rows[0]);
  }

  async useSourceCover(gameId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      update app_private.games set manual_cover_asset_id = null, manual_cover_selected_at = clock_timestamp()
      where id = ${gameId} and trashed_at is null returning id
    `) as Row[];
    return Boolean(rows[0]);
  }

  async removeMedia(assetId: string) {
    return this.db.transaction(async (tx) => {
      // Lock in this order.  The pointer update and soft removal must be one
      // observable change to readers and to the cover-pointer trigger.
      const assetRows = await tx.execute(sql`
        select asset.id, asset.game_id
        from app_private.media_assets asset
        join app_private.games game on game.id = asset.game_id
        where asset.id = ${assetId} and asset.authority_state = 'verified' and game.trashed_at is null
        for update of game, asset
      `) as Row[];
      if (!assetRows[0]) return null;
      const rows = await tx.execute(sql`
        update app_private.games game
        set manual_cover_asset_id = case when game.manual_cover_asset_id = ${assetId} then null else game.manual_cover_asset_id end,
          manual_cover_selected_at = case when game.manual_cover_asset_id = ${assetId} then clock_timestamp() else game.manual_cover_selected_at end
        from app_private.media_assets asset
        where game.id = asset.game_id and asset.id = ${assetId}
          and asset.authority_state = 'verified' and asset.removed_at is null
          and asset.purpose <> 'source_cover'
        returning game.manual_cover_asset_id,
          asset.id as asset_id, asset.game_id, asset.purpose, asset.original_file_name,
          asset.actual_mime_type, asset.byte_size, asset.width, asset.height, asset.removed_at,
          asset.created_at, asset.caption, asset.display_name, asset.description
      `) as Row[];
      if (!rows[0]) return null;
      const removed = await tx.execute(sql`
        update app_private.media_assets set removed_at = clock_timestamp(), removed_reason = 'owner_removed'
        where id = ${assetId} and removed_at is null
        returning id as asset_id, game_id, purpose, original_file_name, actual_mime_type,
          byte_size, width, height, removed_at, created_at, caption, display_name, description
      `) as Row[];
      if (!removed[0]) throw new MediaFinalizeUnavailableError();
      return { asset: assetFrom(removed[0]), manualCoverAssetId: rows[0].manual_cover_asset_id === null ? null : String(rows[0].manual_cover_asset_id) };
    });
  }

  async restoreMedia(assetId: string): Promise<MediaAsset | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select asset.id from app_private.media_assets asset
        join app_private.games game on game.id = asset.game_id
        where asset.id = ${assetId} and asset.authority_state = 'verified' and game.trashed_at is null
        for update of game, asset
      `) as Row[];
      if (!rows[0]) return null;
      const restored = await tx.execute(sql`
        update app_private.media_assets set removed_at = null, removed_reason = null
        where id = ${assetId} and authority_state = 'verified' and removed_at is not null and purpose <> 'source_cover'
        returning id as asset_id, game_id, purpose, original_file_name, actual_mime_type,
          byte_size, width, height, removed_at, created_at, caption, display_name, description
      `) as Row[];
      return restored[0] ? assetFrom(restored[0]) : null;
    });
  }
}

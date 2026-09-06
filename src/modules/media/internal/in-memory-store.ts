import {
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
} from "./errors";
import { MEDIA_THUMBNAIL_SPEC, type BeginMediaRecord, type BeginMediaUploadCommand, type FinalizeClaim, type MediaIngest, type MediaStore, type MediaUploadResult, type ValidatedMediaObject } from "./types";

function sameCommand(ingest: MediaIngest, command: BeginMediaUploadCommand): boolean {
  return ingest.gameId === command.gameId && ingest.purpose === command.purpose && ingest.originalFileName === command.originalFileName && ingest.declaredMimeType === command.declaredMimeType && ingest.declaredByteSize === command.declaredByteSize;
}

export function createInMemoryMediaStore(input: Readonly<{ activeGameIds: readonly string[]; now?: () => Date }>): MediaStore {
  const games = new Set(input.activeGameIds);
  const ingests = new Map<string, MediaIngest>();
  const results = new Map<string, MediaUploadResult>();

  return {
    async begin(command, reserved): Promise<BeginMediaRecord> {
      if (!games.has(command.gameId)) throw new MediaGameUnavailableError();
      const existing = ingests.get(command.idempotencyKey);
      if (existing) {
        if (!sameCommand(existing, command)) throw new MediaUploadIdempotencyConflictError();
        const result = results.get(command.idempotencyKey);
        if (existing.state === "finalized" && result) return { status: "already_finalized", result };
        if (existing.state === "finalizing") return { status: "finalizing" };
        if (existing.state !== "issued") throw new MediaFinalizeUnavailableError();
        return { status: "grantable", ingest: existing, created: false };
      }
      const ingest: MediaIngest = {
        id: reserved.ingestId,
        idempotencyKey: command.idempotencyKey,
        reservedAssetId: reserved.assetId,
        gameId: command.gameId,
        purpose: command.purpose,
        originalObjectPath: reserved.objectPath,
        originalFileName: command.originalFileName,
        declaredMimeType: command.declaredMimeType,
        declaredByteSize: command.declaredByteSize,
        state: "issued",
        leaseToken: null,
        leaseUntil: null,
        staleAfter: reserved.staleAfter,
      };
      ingests.set(command.idempotencyKey, ingest);
      return { status: "grantable", ingest, created: true };
    },
    async renewGrant(key, objectPath, staleAfter) {
      const ingest = ingests.get(key);
      if (!ingest || ingest.state !== "issued" || ingest.originalObjectPath !== objectPath) throw new MediaFinalizeUnavailableError();
      ingests.set(key, { ...ingest, staleAfter });
    },
    async claimFinalize(key, lease): Promise<FinalizeClaim> {
      const result = results.get(key);
      if (result) return { status: "already_finalized", result };
      const ingest = ingests.get(key);
      if (!ingest || ingest.state === "cleanup_pending" || ingest.state === "expired") throw new MediaFinalizeUnavailableError();
      if (ingest.state === "finalizing" && ingest.leaseUntil && new Date(ingest.leaseUntil) > new Date()) throw new MediaFinalizeUnavailableError();
      const claimed = { ...ingest, state: "finalizing" as const, leaseToken: lease.token, leaseUntil: lease.until };
      ingests.set(key, claimed);
      return { status: "claimed", ingest: claimed };
    },
    async releaseIncomplete(key, leaseToken) {
      const ingest = ingests.get(key);
      if (ingest?.state === "finalizing" && ingest.leaseToken === leaseToken) ingests.set(key, { ...ingest, state: "issued", leaseToken: null, leaseUntil: null });
    },
    async rejectInvalid(key, leaseToken) {
      const ingest = ingests.get(key);
      if (ingest?.state === "finalizing" && ingest.leaseToken === leaseToken) ingests.set(key, { ...ingest, state: "cleanup_pending", leaseToken: null, leaseUntil: null });
    },
    async completeFinalize(key, leaseToken, object: ValidatedMediaObject) {
      const existing = results.get(key);
      if (existing) return existing;
      const ingest = ingests.get(key);
      if (!ingest || ingest.state !== "finalizing" || ingest.leaseToken !== leaseToken || !ingest.leaseUntil || new Date(ingest.leaseUntil) <= (input.now?.() ?? new Date())) throw new MediaFinalizeUnavailableError();
      const now = new Date().toISOString();
      const asset = {
        id: ingest.reservedAssetId,
        ingestId: ingest.id,
        gameId: ingest.gameId,
        purpose: ingest.purpose,
        originalObjectPath: ingest.originalObjectPath,
        originalFileName: ingest.originalFileName,
        actualMimeType: object.actualMimeType,
        byteSize: object.byteSize,
        width: object.width,
        height: object.height,
        removedAt: null,
        createdAt: now,
      };
      const thumbnail = ingest.purpose === "attachment" ? null : { assetId: asset.id, spec: MEDIA_THUMBNAIL_SPEC, state: "pending" as const };
      const result = { asset, thumbnail };
      results.set(key, result);
      ingests.set(key, { ...ingest, state: "finalized", leaseToken: null, leaseUntil: null });
      return result;
    },
  };
}

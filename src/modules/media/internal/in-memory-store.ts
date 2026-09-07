import {
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaUploadIdempotencyConflictError,
} from "./errors";
import type { MediaUploadResult } from "../contracts";
import { matchesUploadCommand } from "./matches-upload-command";
import { MEDIA_THUMBNAIL_SPEC, type BeginMediaRecord, type FinalizeClaim, type MediaIngest, type MediaStore, type ValidatedMediaObject } from "./types";
import { decideThumbnailFailure } from "./thumbnail-state";

export function createInMemoryMediaStore(input: Readonly<{ activeGameIds: readonly string[]; now?: () => Date }>): MediaStore {
  const games = new Set(input.activeGameIds);
  const ingests = new Map<string, MediaIngest>();
  const results = new Map<string, MediaUploadResult>();
  const thumbnails = new Map<string, { state: "pending" | "processing" | "ready" | "failed"; attemptCount: number; cycleAttemptCount: number; cycle: number; leaseToken: string | null; leaseUntil: string | null; activeAttemptId: string | null }>();
  const manualCovers = new Map<string, string>();

  function replaceThumbnail(assetId: string, state: "pending" | "processing" | "ready" | "failed"): MediaUploadResult | null {
    for (const [key, result] of results) {
      if (result.asset.id !== assetId || !result.thumbnail) continue;
      const thumbnail = { ...result.thumbnail, state };
      const updated = { ...result, thumbnail };
      results.set(key, updated);
      return updated;
    }
    return null;
  }

  return {
    async begin(command, reserved): Promise<BeginMediaRecord> {
      if (!games.has(command.gameId)) throw new MediaGameUnavailableError();
      const existing = ingests.get(command.idempotencyKey);
      if (existing) {
        if (!matchesUploadCommand(existing, command)) throw new MediaUploadIdempotencyConflictError();
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
      const current = input.now?.() ?? new Date();
      if (ingest.state === "issued" && new Date(ingest.staleAfter) <= current) throw new MediaFinalizeUnavailableError();
      if (ingest.state === "finalizing" && ingest.leaseUntil && new Date(ingest.leaseUntil) > current) return { status: "finalizing" };
      const claimed = { ...ingest, state: "finalizing" as const, leaseToken: lease.token, leaseUntil: lease.until };
      ingests.set(key, claimed);
      return { status: "claimed", ingest: claimed };
    },
    async releaseIncomplete(key, leaseToken) {
      const ingest = ingests.get(key);
      if (!ingest || ingest.state !== "finalizing" || ingest.leaseToken !== leaseToken || !ingest.leaseUntil || new Date(ingest.leaseUntil) <= (input.now?.() ?? new Date())) throw new MediaFinalizeUnavailableError();
      ingests.set(key, { ...ingest, state: "issued", leaseToken: null, leaseUntil: null });
    },
    async rejectInvalid(key, leaseToken) {
      const ingest = ingests.get(key);
      if (!ingest || ingest.state !== "finalizing" || ingest.leaseToken !== leaseToken || !ingest.leaseUntil || new Date(ingest.leaseUntil) <= (input.now?.() ?? new Date())) throw new MediaFinalizeUnavailableError();
      ingests.set(key, { ...ingest, state: "cleanup_pending", leaseToken: null, leaseUntil: null });
    },
    async completeFinalize(key, leaseToken, object: ValidatedMediaObject) {
      const existing = results.get(key);
      if (existing) return existing;
      const ingest = ingests.get(key);
      if (!ingest || ingest.state !== "finalizing" || ingest.leaseToken !== leaseToken || !ingest.leaseUntil || new Date(ingest.leaseUntil) <= (input.now?.() ?? new Date())) throw new MediaFinalizeUnavailableError();
      const now = new Date().toISOString();
      const asset = {
        id: ingest.reservedAssetId,
        gameId: ingest.gameId,
        purpose: ingest.purpose,
        originalFileName: ingest.originalFileName,
        actualMimeType: object.actualMimeType,
        byteSize: object.byteSize,
        width: object.width,
        height: object.height,
        removedAt: null,
        createdAt: now,
        caption: null,
        displayName: null,
        description: null,
      };
      const thumbnail = ingest.purpose === "attachment" ? null : { assetId: asset.id, spec: MEDIA_THUMBNAIL_SPEC, state: "pending" as const };
      const result = { asset, thumbnail };
      results.set(key, result);
      if (thumbnail) thumbnails.set(asset.id, { state: "pending", attemptCount: 0, cycleAttemptCount: 0, cycle: 1, leaseToken: null, leaseUntil: null, activeAttemptId: null });
      ingests.set(key, { ...ingest, state: "finalized", leaseToken: null, leaseUntil: null });
      return result;
    },
    async findReadableOriginal(assetId) {
      const result = [...results.values()].find((candidate) => candidate.asset.id === assetId);
      if (!result || result.asset.removedAt !== null) return null;
      const ingest = [...ingests.values()].find((candidate) => candidate.reservedAssetId === assetId && candidate.state === "finalized");
      return ingest ? { path: ingest.originalObjectPath, fileName: result.asset.originalFileName } : null;
    },
    async findReadableThumbnail(assetId) {
      const result = [...results.values()].find((candidate) => candidate.asset.id === assetId);
      return result?.asset.removedAt === null && thumbnails.get(assetId)?.state === "ready"
        ? { path: `thumbnails/${assetId}/current.webp` }
        : null;
    },
    async claimThumbnail(assetId, lease) {
      const job = thumbnails.get(assetId);
      if (!job) return { status: results.has(assetId) ? "not_found" as const : "not_found" as const };
      const current = input.now?.() ?? new Date();
      if (job.state === "ready" || job.state === "failed") return { status: "not_ready" as const };
      if (job.state === "processing" && job.leaseUntil && new Date(job.leaseUntil) > current) return { status: "busy" as const };
      const attemptCount = job.attemptCount + 1;
      const cycleAttemptCount = job.cycleAttemptCount + 1;
      const attemptId = `${assetId}:${attemptCount}`;
      const leaseUntil = new Date(current.getTime() + 5 * 60 * 1000).toISOString();
      thumbnails.set(assetId, { ...job, state: "processing", attemptCount, cycleAttemptCount, leaseToken: lease.token, leaseUntil, activeAttemptId: attemptId });
      const ingest = [...ingests.values()].find((candidate) => candidate.reservedAssetId === assetId);
      if (!ingest) return { status: "not_found" as const };
      return { status: "claimed" as const, derivativeId: assetId, assetId, originalObjectPath: ingest.originalObjectPath, attempt: { id: attemptId, number: attemptCount, objectPath: `thumbnails/${assetId}/${attemptId}.webp`, cycleAttemptCount } };
    },
    async markThumbnailUploaded(claim) {
      const job = thumbnails.get(claim.derivativeId);
      if (!job || job.leaseToken !== claim.leaseToken || job.activeAttemptId !== claim.attemptId || job.attemptCount !== claim.attemptNumber) throw new MediaFinalizeUnavailableError();
    },
    async adoptThumbnail(claim) {
      const job = thumbnails.get(claim.derivativeId);
      if (!job || job.leaseToken !== claim.leaseToken || job.activeAttemptId !== claim.attemptId || job.attemptCount !== claim.attemptNumber) throw new MediaFinalizeUnavailableError();
      if (!replaceThumbnail(claim.derivativeId, "ready")) throw new MediaFinalizeUnavailableError();
      thumbnails.set(claim.derivativeId, { ...job, state: "ready", leaseToken: null, leaseUntil: null, activeAttemptId: null });
    },
    async failThumbnail(claim) {
      const job = thumbnails.get(claim.derivativeId);
      if (!job || job.leaseToken !== claim.leaseToken || job.activeAttemptId !== claim.attemptId || job.attemptCount !== claim.attemptNumber) throw new MediaFinalizeUnavailableError();
      const outcome = decideThumbnailFailure({ cycleAttemptCount: job.cycleAttemptCount, deterministic: claim.deterministic });
      if (!replaceThumbnail(claim.derivativeId, outcome.state)) throw new MediaFinalizeUnavailableError();
      thumbnails.set(claim.derivativeId, { ...job, state: outcome.state, leaseToken: null, leaseUntil: null, activeAttemptId: null });
      return { retryDelayMs: outcome.retryDelayMs };
    },
    async retryThumbnail(assetId) {
      const job = thumbnails.get(assetId);
      const updated = replaceThumbnail(assetId, "pending");
      if (!job || !updated?.thumbnail || job.state !== "failed") throw new MediaFinalizeUnavailableError();
      thumbnails.set(assetId, { ...job, state: "pending", cycle: job.cycle + 1, cycleAttemptCount: 0, leaseToken: null, leaseUntil: null, activeAttemptId: null });
      return updated.thumbnail;
    },
    async listGameMedia(gameId) {
      if (!games.has(gameId)) throw new MediaGameUnavailableError();
      return {
        manualCoverAssetId: manualCovers.get(gameId) ?? null,
        sourceCover: null,
        items: [...results.values()].filter((result) => result.asset.gameId === gameId && result.asset.removedAt === null).map((result) => ({
          asset: result.asset, thumbnail: result.thumbnail, thumbnailPath: null,
        })),
      };
    },
    async updateMediaMetadata(command) {
      for (const [key, result] of results) {
        if (result.asset.id !== command.assetId || result.asset.removedAt !== null || result.asset.purpose === "custom_cover") continue;
        const clean = (value: string | null | undefined) => value === undefined ? undefined : value?.trim() || null;
        const updated = { ...result, asset: { ...result.asset,
          ...(command.caption === undefined ? {} : { caption: clean(command.caption) }),
          ...(command.displayName === undefined ? {} : { displayName: clean(command.displayName) }),
          ...(command.description === undefined ? {} : { description: clean(command.description) }),
        } };
        results.set(key, updated);
        return updated.asset;
      }
      return null;
    },
    async selectManualCover(gameId, assetId) {
      const asset = [...results.values()].find((result) => result.asset.id === assetId)?.asset;
      if (!games.has(gameId) || !asset || asset.gameId !== gameId || asset.removedAt !== null || !["gallery_image", "custom_cover"].includes(asset.purpose)) return false;
      manualCovers.set(gameId, assetId);
      return true;
    },
    async useSourceCover(gameId) {
      if (!games.has(gameId)) return false;
      manualCovers.delete(gameId);
      return true;
    },
    async removeMedia(assetId) {
      for (const [key, result] of results) {
        if (result.asset.id !== assetId || result.asset.removedAt !== null || result.asset.purpose === "source_cover") continue;
        const removed = { ...result, asset: { ...result.asset, removedAt: new Date().toISOString() } };
        results.set(key, removed);
        const manualCoverAssetId = manualCovers.get(result.asset.gameId) === assetId ? (manualCovers.delete(result.asset.gameId), null) : manualCovers.get(result.asset.gameId) ?? null;
        return { asset: removed.asset, manualCoverAssetId };
      }
      return null;
    },
    async restoreMedia(assetId) {
      for (const [key, result] of results) {
        if (result.asset.id !== assetId || result.asset.removedAt === null || result.asset.purpose === "source_cover") continue;
        const restored = { ...result, asset: { ...result.asset, removedAt: null } };
        results.set(key, restored);
        return restored.asset;
      }
      return null;
    },
  };
}

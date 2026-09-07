import { randomUUID } from "node:crypto";
import type { MediaDerivative, MediaService } from "../contracts";
import { assertMediaFileSize } from "../file-size-policy";
import {
  MediaFileEmptyError,
  MediaFileTooLargeError,
  MediaBeginUnavailableError,
  MediaFinalizeUnavailableError,
  MediaGameUnavailableError,
  MediaOperationError,
  MediaStoredObjectInvalidError,
  MediaUploadIncompleteError,
  MediaAssetUnavailableError,
  MediaStorageUnavailableError,
  MediaReadUnavailableError,
  MediaThumbnailUnavailableError,
  MediaThumbnailUnsupportedError,
} from "./errors";
import { identifyAttachmentMime, validateRasterImage } from "./image-header";
import type { MediaIngest, MediaObjectStore, MediaStore, ValidatedMediaObject } from "./types";
import { transformThumbnail } from "./thumbnail-transform";

export type InternalMediaService = MediaService & Readonly<{ processThumbnail(assetId: string): Promise<void> }>;

function normalizeMime(value: string): string {
  return value.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
}

async function validateStoredObject(objects: MediaObjectStore, ingest: MediaIngest): Promise<ValidatedMediaObject> {
  const metadata = await objects.inspect(ingest.originalObjectPath);
  if (!metadata) throw new MediaUploadIncompleteError();
  assertMediaFileSize(metadata.byteSize);
  if (metadata.path !== ingest.originalObjectPath || metadata.byteSize !== ingest.declaredByteSize) throw new MediaStoredObjectInvalidError();
  if (ingest.purpose === "attachment") {
    const actualMimeType = await identifyAttachmentMime(objects.read(ingest.originalObjectPath), metadata.byteSize);
    return { actualMimeType, byteSize: metadata.byteSize, width: null, height: null };
  }
  const image = await validateRasterImage(objects.read(ingest.originalObjectPath), metadata.byteSize);
  if (normalizeMime(ingest.declaredMimeType) !== image.mimeType || normalizeMime(metadata.mimeType) !== image.mimeType) throw new MediaStoredObjectInvalidError();
  return { actualMimeType: image.mimeType, byteSize: metadata.byteSize, width: image.width, height: image.height };
}

export function createMediaService(dependencies: Readonly<{ store: MediaStore; objects: MediaObjectStore; now?: () => Date; sleep?: (milliseconds: number) => Promise<void> }>): InternalMediaService {
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async beginMediaUpload(owner, command) {
      void owner;
      try {
        assertMediaFileSize(command.declaredByteSize);
        if (!command.originalFileName.trim() || !command.declaredMimeType.trim()) throw new MediaStoredObjectInvalidError();
        const ingestId = randomUUID();
        const assetId = randomUUID();
        const objectPath = `originals/${assetId}/${randomUUID()}`;
        const staleAfter = new Date(now().getTime() + 26 * 60 * 60 * 1000).toISOString();
        const begun = await dependencies.store.begin(command, { ingestId, assetId, objectPath, staleAfter });
        if (begun.status === "already_finalized" || begun.status === "finalizing") return begun;
        const { ingest } = begun;
        await dependencies.store.renewGrant(ingest.idempotencyKey, ingest.originalObjectPath, staleAfter);
        const grant = await dependencies.objects.createUploadGrant(ingest.originalObjectPath);
        return {
          status: "upload_grant",
          ingestId: ingest.id,
          assetId: ingest.reservedAssetId,
          upload: {
            protocol: "tus",
            endpoint: grant.uploadUrl,
            headers: { "x-signature": grant.token },
            metadata: { bucketName: "game-media", objectName: ingest.originalObjectPath, contentType: normalizeMime(ingest.declaredMimeType), cacheControl: "0" },
            declaredByteSize: ingest.declaredByteSize,
            maxByteSize: 52_428_800,
            chunkSize: 6_291_456,
            retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
            uploadDataDuringCreation: true,
            resumeFromPreviousUpload: true,
            removeFingerprintOnSuccess: true,
            upsert: false,
            fingerprint: `puizeru:${ingest.id}:${ingest.originalObjectPath}`,
          },
          expiresAt: grant.expiresAt,
        };
      } catch (error) {
        if (error instanceof MediaStorageUnavailableError) throw new MediaBeginUnavailableError();
        if (error instanceof MediaOperationError) throw error;
        throw new MediaBeginUnavailableError();
      }
    },
    async finalizeMediaUpload(owner, command) {
      void owner;
      const token = randomUUID();
      const until = new Date(now().getTime() + 5 * 60 * 1000).toISOString();
      try {
        const claim = await dependencies.store.claimFinalize(command.idempotencyKey, { token, until });
        if (claim.status === "already_finalized") return claim.result;
        if (claim.status === "finalizing") return claim;
        const object = await validateStoredObject(dependencies.objects, claim.ingest);
        return await dependencies.store.completeFinalize(command.idempotencyKey, token, object);
      } catch (error) {
        try {
          if (error instanceof MediaUploadIncompleteError) {
            await dependencies.store.releaseIncomplete(command.idempotencyKey, token);
            throw error;
          }
          if (error instanceof MediaStoredObjectInvalidError || error instanceof MediaFileEmptyError || error instanceof MediaFileTooLargeError) {
            await dependencies.store.rejectInvalid(command.idempotencyKey, token);
            throw error;
          }
        } catch (transitionError) {
          if (transitionError instanceof MediaOperationError) throw transitionError;
          throw new MediaFinalizeUnavailableError();
        }
        if (error instanceof MediaStorageUnavailableError) throw new MediaFinalizeUnavailableError();
        if (error instanceof MediaOperationError) throw error;
        throw new MediaFinalizeUnavailableError();
      }
    },
    async retryThumbnail(owner, command): Promise<MediaDerivative> {
      void owner;
      const thumbnail = await dependencies.store.retryThumbnail(command.assetId);
      if (!thumbnail) throw new MediaFinalizeUnavailableError();
      return thumbnail;
    },
    async processThumbnail(assetId): Promise<void> {
      for (let retry = 0; retry < 3; retry += 1) {
        const token = randomUUID();
        const claim = await dependencies.store.claimThumbnail(assetId, { token });
        if (claim.status !== "claimed") return;
        const attempt = { derivativeId: claim.derivativeId, attemptId: claim.attempt.id, attemptNumber: claim.attempt.number, leaseToken: token };
        try {
          const transformed = await transformThumbnail(dependencies.objects.read(claim.originalObjectPath));
          await dependencies.objects.uploadDerivative(claim.attempt.objectPath, transformed.bytes);
          await dependencies.store.markThumbnailUploaded(attempt);
          await dependencies.store.adoptThumbnail({ ...attempt, width: transformed.width, height: transformed.height, byteSize: transformed.bytes.byteLength });
          return;
        } catch (error) {
          if (error instanceof MediaThumbnailUnsupportedError) {
            await dependencies.store.failThumbnail({ ...attempt, deterministic: true });
            return;
          }
          let failed: Readonly<{ retryDelayMs: number | null }>;
          try {
            failed = await dependencies.store.failThumbnail({ ...attempt, deterministic: false });
          } catch (transitionError) {
            if (transitionError instanceof MediaOperationError) throw transitionError;
            throw new MediaThumbnailUnavailableError();
          }
          if (failed.retryDelayMs === null || retry === 2) return;
          await sleep(failed.retryDelayMs);
        }
      }
    },
    async issueOriginalRead(owner, query) {
      void owner;
      let original: Awaited<ReturnType<MediaStore["findReadableOriginal"]>>;
      try {
        original = await dependencies.store.findReadableOriginal(query.assetId);
      } catch { throw new MediaReadUnavailableError(); }
      if (!original) throw new MediaAssetUnavailableError();
      try {
        const grant = await dependencies.objects.createOriginalReadGrant(original.path, original.fileName, 60);
        return { status: "original_read", ...grant, disposition: "attachment" };
      } catch (error) { throw error instanceof MediaOperationError ? error : new MediaStorageUnavailableError(); }
    },
    async listGameMedia(owner, query) {
      void owner;
      let gallery: Awaited<ReturnType<MediaStore["listGameMedia"]>>;
      try { gallery = await dependencies.store.listGameMedia(query.gameId); }
      catch (error) { throw error instanceof MediaOperationError ? error : new MediaReadUnavailableError(); }
      const expose = async (item: (typeof gallery.items)[number]) => {
        if (!item.thumbnailPath) {
          return { ...item, thumbnailUrl: null, thumbnailExpiresAt: null, thumbnailPath: undefined };
        }
        if (!dependencies.objects.createThumbnailReadGrant) throw new MediaReadUnavailableError();
        try {
          const read = await dependencies.objects.createThumbnailReadGrant(item.thumbnailPath, 300);
          return { asset: item.asset, thumbnail: item.thumbnail, thumbnailUrl: read.url, thumbnailExpiresAt: read.expiresAt, thumbnailError: null };
        } catch { return { asset: item.asset, thumbnail: item.thumbnail, thumbnailUrl: null, thumbnailExpiresAt: null, thumbnailError: "media_thumbnail_read_unavailable" as const }; }
      };
      const exposeBounded = async (items: readonly (typeof gallery.items)[number][]) => {
        const output: Awaited<ReturnType<typeof expose>>[] = new Array(items.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
          while (next < items.length) {
            const index = next++;
            output[index] = await expose(items[index]!);
          }
        }));
        return output;
      };
      return {
        gameId: query.gameId,
        manualCoverAssetId: gallery.manualCoverAssetId,
        sourceCover: gallery.sourceCover ? await expose(gallery.sourceCover) : null,
        items: await exposeBounded(gallery.items),
      };
    },
    async updateMediaMetadata(owner, command) {
      void owner;
      try {
        const asset = await dependencies.store.updateMediaMetadata(command);
        if (!asset) throw new MediaAssetUnavailableError();
        return asset;
      } catch (error) { throw error instanceof MediaOperationError ? error : new MediaFinalizeUnavailableError(); }
    },
    async selectManualCover(owner, command) {
      void owner;
      try {
        if (!await dependencies.store.selectManualCover(command.gameId, command.assetId)) throw new MediaAssetUnavailableError();
        return { manualCoverAssetId: command.assetId };
      } catch (error) { throw error instanceof MediaOperationError ? error : new MediaFinalizeUnavailableError(); }
    },
    async useSourceCover(owner, command) {
      void owner;
      try {
        if (!await dependencies.store.useSourceCover(command.gameId)) throw new MediaGameUnavailableError();
        return { manualCoverAssetId: null };
      } catch (error) { throw error instanceof MediaOperationError ? error : new MediaFinalizeUnavailableError(); }
    },
  };
}

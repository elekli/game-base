import { randomUUID } from "node:crypto";
import { identifyAttachmentMime, validateRasterImage } from "./internal/image-header";
import { assertMediaFileSize } from "./file-size-policy";
import {
  MediaFileEmptyError,
  MediaFileTooLargeError,
  MediaStoredObjectInvalidError,
  MediaUploadIncompleteError,
} from "./internal/errors";
import { type MediaIngest, type MediaObjectStore, type MediaService, type MediaStore, type ValidatedMediaObject } from "./internal/types";

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

export function createMediaService(dependencies: Readonly<{ store: MediaStore; objects: MediaObjectStore; now?: () => Date }>): MediaService {
  const now = dependencies.now ?? (() => new Date());
  return {
    async beginMediaUpload(owner, command) {
      void owner;
      assertMediaFileSize(command.declaredByteSize);
      if (!command.originalFileName.trim() || !command.declaredMimeType.trim()) throw new MediaStoredObjectInvalidError();
      const ingestId = randomUUID();
      const assetId = randomUUID();
      const objectPath = `originals/${assetId}/${randomUUID()}`;
      const staleAfter = new Date(now().getTime() + 26 * 60 * 60 * 1000).toISOString();
      const { ingest } = await dependencies.store.begin(command, { ingestId, assetId, objectPath, staleAfter });
      await dependencies.store.renewGrant(ingest.idempotencyKey, ingest.originalObjectPath, staleAfter);
      const grant = await dependencies.objects.createUploadGrant(ingest.originalObjectPath);
      return { ingestId: ingest.id, assetId: ingest.reservedAssetId, objectPath: ingest.originalObjectPath, ...grant };
    },
    async finalizeMediaUpload(owner, command) {
      void owner;
      const token = randomUUID();
      const until = new Date(now().getTime() + 5 * 60 * 1000).toISOString();
      const claim = await dependencies.store.claimFinalize(command.idempotencyKey, { token, until });
      if (claim.status === "already_finalized") return claim.result;
      try {
        const object = await validateStoredObject(dependencies.objects, claim.ingest);
        return await dependencies.store.completeFinalize(command.idempotencyKey, token, object);
      } catch (error) {
        if (error instanceof MediaUploadIncompleteError) await dependencies.store.releaseIncomplete(command.idempotencyKey, token);
        else if (error instanceof MediaStoredObjectInvalidError || error instanceof MediaFileEmptyError || error instanceof MediaFileTooLargeError) await dependencies.store.rejectInvalid(command.idempotencyKey, token);
        throw error;
      }
    },
  };
}

export * from "./internal/errors";
export * from "./internal/types";
export * from "./internal/in-memory-store";
export * from "./file-size-policy";

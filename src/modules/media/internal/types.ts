import type { OwnerIdentity } from "@/shared/auth/verify-access-token";

export const MEDIA_MAX_PIXELS = 100_000_000;
export const MEDIA_THUMBNAIL_SPEC = "thumb_webp_v1" as const;

export type MediaPurpose = "gallery_image" | "custom_cover" | "attachment";
export type ImageMediaPurpose = Exclude<MediaPurpose, "attachment">;

export type BeginMediaUploadCommand = Readonly<{
  idempotencyKey: string;
  gameId: string;
  purpose: MediaPurpose;
  originalFileName: string;
  declaredMimeType: string;
  declaredByteSize: number;
}>;

export type FinalizeMediaUploadCommand = Readonly<{ idempotencyKey: string }>;

export type UploadGrant = Readonly<{
  ingestId: string;
  assetId: string;
  objectPath: string;
  token: string;
  expiresAt: string;
}>;

export type MediaAsset = Readonly<{
  id: string;
  ingestId: string;
  gameId: string;
  purpose: MediaPurpose;
  originalObjectPath: string;
  originalFileName: string;
  actualMimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  removedAt: string | null;
  createdAt: string;
}>;

export type MediaDerivative = Readonly<{
  assetId: string;
  spec: typeof MEDIA_THUMBNAIL_SPEC;
  state: "pending" | "processing" | "ready" | "failed";
}>;

export type MediaUploadResult = Readonly<{
  asset: MediaAsset;
  thumbnail: MediaDerivative | null;
}>;

export type MediaObjectStore = Readonly<{
  createUploadGrant(path: string): Promise<Readonly<{ token: string; expiresAt: string }>>;
  inspect(path: string): Promise<Readonly<{ path: string; byteSize: number; mimeType: string }> | null>;
  read(path: string): AsyncIterable<Uint8Array>;
}>;

export type MediaIngest = Readonly<{
  id: string;
  idempotencyKey: string;
  reservedAssetId: string;
  gameId: string;
  purpose: MediaPurpose;
  originalObjectPath: string;
  originalFileName: string;
  declaredMimeType: string;
  declaredByteSize: number;
  state: "issued" | "finalizing" | "finalized" | "cleanup_pending" | "expired";
  leaseToken: string | null;
  leaseUntil: string | null;
  staleAfter: string;
}>;

export type BeginMediaRecord = Readonly<{
  ingest: MediaIngest;
  created: boolean;
}>;

export type FinalizeClaim =
  | Readonly<{ status: "already_finalized"; result: MediaUploadResult }>
  | Readonly<{ status: "claimed"; ingest: MediaIngest }>;

export type ValidatedMediaObject = Readonly<{
  actualMimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}>;

export type MediaStore = Readonly<{
  begin(command: BeginMediaUploadCommand, reserved: Readonly<{ ingestId: string; assetId: string; objectPath: string; staleAfter: string }>): Promise<BeginMediaRecord>;
  renewGrant(idempotencyKey: string, objectPath: string, staleAfter: string): Promise<void>;
  claimFinalize(idempotencyKey: string, lease: Readonly<{ token: string; until: string }>): Promise<FinalizeClaim>;
  releaseIncomplete(idempotencyKey: string, leaseToken: string): Promise<void>;
  rejectInvalid(idempotencyKey: string, leaseToken: string): Promise<void>;
  completeFinalize(idempotencyKey: string, leaseToken: string, object: ValidatedMediaObject): Promise<MediaUploadResult>;
}>;

export type MediaService = Readonly<{
  beginMediaUpload(owner: OwnerIdentity, command: BeginMediaUploadCommand): Promise<UploadGrant>;
  finalizeMediaUpload(owner: OwnerIdentity, command: FinalizeMediaUploadCommand): Promise<MediaUploadResult>;
}>;

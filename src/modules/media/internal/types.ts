import type {
  BeginMediaUploadCommand,
  MediaPurpose,
  MediaUploadResult,
  MediaAsset,
  MediaDerivative,
  StoredMediaPurpose,
} from "../contracts";

export const MEDIA_MAX_PIXELS = 100_000_000;
export const MEDIA_THUMBNAIL_SPEC = "thumb_webp_v1" as const;

export type ImageMediaPurpose = Exclude<MediaPurpose, "attachment">;

export type MediaObjectStore = Readonly<{
  createUploadGrant(path: string): Promise<Readonly<{ uploadUrl: string; token: string; expiresAt: string }>>;
  createOriginalReadGrant(path: string, fileName: string, dispositionOrExpires?: "inline" | "attachment" | 60, expiresInSeconds?: 60): Promise<Readonly<{ url: string; expiresAt: string }>>;
  createThumbnailReadGrant?(path: string, expiresInSeconds?: 300): Promise<Readonly<{ url: string; expiresAt: string }>>;
  inspect(path: string): Promise<Readonly<{ path: string; byteSize: number; mimeType: string }> | null>;
  read(path: string): AsyncIterable<Uint8Array>;
  uploadDerivative(path: string, bytes: Uint8Array): Promise<void>;
  deleteDerivative(path: string): Promise<void>;
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

export type BeginMediaRecord =
  | Readonly<{ status: "grantable"; ingest: MediaIngest; created: boolean }>
  | Readonly<{ status: "finalizing" }>
  | Readonly<{ status: "already_finalized"; result: MediaUploadResult }>;

export type FinalizeClaim =
  | Readonly<{ status: "already_finalized"; result: MediaUploadResult }>
  | Readonly<{ status: "finalizing" }>
  | Readonly<{ status: "claimed"; ingest: MediaIngest }>;

export type ValidatedMediaObject = Readonly<{
  actualMimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}>;

export type ThumbnailAttempt = Readonly<{
  id: string;
  number: number;
  objectPath: string;
  cycleAttemptCount: number;
}>;

export type ThumbnailClaim =
  | Readonly<{ status: "busy" | "not_found" | "not_ready" }>
  | Readonly<{
    status: "claimed";
    derivativeId: string;
    assetId: string;
    originalObjectPath: string;
    attempt: ThumbnailAttempt;
  }>;

export type MediaCleanupClaim = Readonly<{
  jobId: string;
  attemptId: string;
  objectPath: string;
  attemptCount: number;
}>;

export type MediaReconcileResult = Readonly<{
  status: "completed" | "skipped" | "failed";
  thumbnailsWoken: number;
  cleanupCleaned: number;
  cleanupFailed: number;
  quotaState: "ok" | "warning" | "stop_writes";
}>;

export type MediaCapacitySnapshot = Readonly<{
  usedBytes: number;
  capacityBytes: number;
}>;

export type MediaStore = Readonly<{
  begin(command: BeginMediaUploadCommand, reserved: Readonly<{ ingestId: string; assetId: string; objectPath: string; staleAfter: string }>): Promise<BeginMediaRecord>;
  renewGrant(idempotencyKey: string, objectPath: string, staleAfter: string): Promise<void>;
  claimFinalize(idempotencyKey: string, lease: Readonly<{ token: string; until: string }>): Promise<FinalizeClaim>;
  releaseIncomplete(idempotencyKey: string, leaseToken: string): Promise<void>;
  rejectInvalid(idempotencyKey: string, leaseToken: string): Promise<void>;
  completeFinalize(idempotencyKey: string, leaseToken: string, object: ValidatedMediaObject): Promise<MediaUploadResult>;
  findReadableOriginal(assetId: string): Promise<Readonly<{ path: string; fileName: string; purpose: StoredMediaPurpose; actualMimeType: string }> | null>;
  findReadableThumbnail(assetId: string): Promise<Readonly<{ path: string }> | null>;
  claimThumbnail(assetId: string, lease: Readonly<{ token: string; durationMs?: number }>): Promise<ThumbnailClaim>;
  markThumbnailUploaded(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string }>): Promise<void>;
  adoptThumbnail(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string; width: number; height: number; byteSize: number }>): Promise<void>;
  failThumbnail(claim: Readonly<{ derivativeId: string; attemptId: string; attemptNumber: number; leaseToken: string; deterministic: boolean }>): Promise<Readonly<{ retryDelayMs: number | null }>>;
  retryThumbnail(assetId: string): Promise<MediaUploadResult["thumbnail"]>;
  listGameMedia(gameId: string): Promise<Readonly<{
    manualCoverAssetId: string | null;
    sourceCover: MediaStoredGalleryItem | null;
    items: readonly MediaStoredGalleryItem[];
  }>>;
  updateMediaMetadata(command: Readonly<{ assetId: string; caption?: string | null; displayName?: string | null; description?: string | null }>): Promise<MediaAsset | null>;
  selectManualCover(gameId: string, assetId: string): Promise<boolean>;
  useSourceCover(gameId: string): Promise<boolean>;
  removeMedia(assetId: string): Promise<Readonly<{ asset: MediaAsset; manualCoverAssetId: string | null }> | null>;
  restoreMedia(assetId: string): Promise<MediaAsset | null>;
  claimReconciliationRun(leaseToken: string): Promise<boolean>;
  completeReconciliationRun(leaseToken: string): Promise<void>;
  findReconcileThumbnails(limit: number): Promise<readonly string[]>;
  claimCleanupJobs(limit: number, leaseToken: string): Promise<readonly MediaCleanupClaim[]>;
  completeCleanup(jobId: string, leaseToken: string): Promise<void>;
  failCleanup(jobId: string, leaseToken: string): Promise<void>;
}>;

export type MediaStoredGalleryItem = Readonly<{
  asset: MediaAsset;
  thumbnail: MediaDerivative | null;
  thumbnailPath: string | null;
}>;

import type { OwnerIdentity } from "@/shared/auth/verify-access-token";

export type MediaPurpose = "gallery_image" | "custom_cover" | "attachment";

export type BeginMediaUploadCommand = Readonly<{
  idempotencyKey: string;
  gameId: string;
  purpose: MediaPurpose;
  originalFileName: string;
  declaredMimeType: string;
  declaredByteSize: number;
}>;

export type FinalizeMediaUploadCommand = Readonly<{ idempotencyKey: string }>;
export type RetryThumbnailCommand = Readonly<{ assetId: string }>;

export type UploadGrant = Readonly<{
  status: "upload_grant";
  ingestId: string;
  assetId: string;
  upload: Readonly<{
    protocol: "tus";
    endpoint: string;
    headers: Readonly<{ "x-signature": string }>;
    metadata: Readonly<{ bucketName: "game-media"; objectName: string; contentType: string; cacheControl: "0" }>;
    declaredByteSize: number;
    maxByteSize: number;
    chunkSize: 6291456;
    retryDelays: readonly [0, 3000, 5000, 10000, 20000];
    uploadDataDuringCreation: true;
    resumeFromPreviousUpload: true;
    removeFingerprintOnSuccess: true;
    upsert: false;
    fingerprint: string;
  }>;
  expiresAt: string;
}>;

export type OriginalMediaRead = Readonly<{ status: "original_read"; url: string; expiresAt: string; disposition: "attachment" }>;

export type MediaAsset = Readonly<{
  id: string;
  gameId: string;
  purpose: MediaPurpose;
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
  spec: "thumb_webp_v1";
  state: "pending" | "processing" | "ready" | "failed";
}>;

export type MediaUploadResult = Readonly<{
  asset: MediaAsset;
  thumbnail: MediaDerivative | null;
}>;

export type BeginMediaUploadResult = UploadGrant
  | Readonly<{ status: "finalizing" }>
  | Readonly<{ status: "already_finalized"; result: MediaUploadResult }>;

export type FinalizeMediaUploadResult = MediaUploadResult | Readonly<{ status: "finalizing" }>;

export type MediaService = Readonly<{
  beginMediaUpload(owner: OwnerIdentity, command: BeginMediaUploadCommand): Promise<BeginMediaUploadResult>;
  finalizeMediaUpload(owner: OwnerIdentity, command: FinalizeMediaUploadCommand): Promise<FinalizeMediaUploadResult>;
  retryThumbnail(owner: OwnerIdentity, command: RetryThumbnailCommand): Promise<MediaDerivative>;
  issueOriginalRead(owner: OwnerIdentity, query: Readonly<{ assetId: string }>): Promise<OriginalMediaRead>;
}>;

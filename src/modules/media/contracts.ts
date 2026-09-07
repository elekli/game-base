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

export type UploadGrant = Readonly<{
  status: "upload_grant";
  ingestId: string;
  assetId: string;
  uploadUrl: string;
  token: string;
  expiresAt: string;
}>;

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
}>;

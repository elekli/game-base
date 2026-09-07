import type {
  BeginMediaUploadCommand,
  MediaPurpose,
  MediaUploadResult,
} from "../contracts";

export const MEDIA_MAX_PIXELS = 100_000_000;
export const MEDIA_THUMBNAIL_SPEC = "thumb_webp_v1" as const;

export type ImageMediaPurpose = Exclude<MediaPurpose, "attachment">;

export type MediaObjectStore = Readonly<{
  createUploadGrant(path: string): Promise<Readonly<{ uploadUrl: string; token: string; expiresAt: string }>>;
  createOriginalReadGrant(path: string, fileName: string, expiresInSeconds: 60): Promise<Readonly<{ url: string; expiresAt: string }>>;
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

export type MediaStore = Readonly<{
  begin(command: BeginMediaUploadCommand, reserved: Readonly<{ ingestId: string; assetId: string; objectPath: string; staleAfter: string }>): Promise<BeginMediaRecord>;
  renewGrant(idempotencyKey: string, objectPath: string, staleAfter: string): Promise<void>;
  claimFinalize(idempotencyKey: string, lease: Readonly<{ token: string; until: string }>): Promise<FinalizeClaim>;
  releaseIncomplete(idempotencyKey: string, leaseToken: string): Promise<void>;
  rejectInvalid(idempotencyKey: string, leaseToken: string): Promise<void>;
  completeFinalize(idempotencyKey: string, leaseToken: string, object: ValidatedMediaObject): Promise<MediaUploadResult>;
  findReadableOriginal(assetId: string): Promise<Readonly<{ path: string; fileName: string }> | null>;
}>;

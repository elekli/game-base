"use client";

import { defaultOptions, Upload, type HttpStack } from "tus-js-client";
import type { UploadGrant } from "./contracts";

const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
const TUS_RETRY_DELAYS = [0, 3_000, 5_000, 10_000, 20_000] as const;
const TUS_ENDPOINT_PATH = "/storage/v1/upload/resumable/sign";
const MEDIA_MAX_BYTES = 52_428_800;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LOCAL_TUS_ENDPOINT = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/storage\/v1\/upload\/resumable\/sign$/;

export type BrowserPreviousUpload = Readonly<{
  size: number | null;
  metadata: Record<string, string>;
  creationTime: string;
  urlStorageKey: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
}>;

export type BrowserUploadUrlStorage = Readonly<{
  findAllUploads(): Promise<BrowserPreviousUpload[]>;
  findUploadsByFingerprint(fingerprint: string): Promise<BrowserPreviousUpload[]>;
  removeUpload(urlStorageKey: string): Promise<void>;
  addUpload(fingerprint: string, upload: BrowserPreviousUpload): Promise<string>;
}>;

export type BrowserMediaUploadResult =
  | Readonly<{ status: "uploaded" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "failed"; error: MediaBrowserUploadError }>;

export type BrowserMediaUploadTask = Readonly<{
  completion: Promise<BrowserMediaUploadResult>;
  cancel(): Promise<void>;
}>;

export class MediaBrowserUploadError extends Error {
  readonly name = "MediaBrowserUploadError";

  constructor(
    readonly code: "media_upload_grant_invalid" | "media_upload_file_invalid" | "media_upload_failed",
    message: string,
  ) {
    super(message);
  }
}

type BlobSource = Readonly<{
  size: number;
  slice(start: number, end: number): Promise<Readonly<{ value: Uint8Array<ArrayBuffer> & { size: number }; done: boolean }>>;
  close(): void;
}>;

const blobFileReader = {
  async openFile(input: unknown): Promise<BlobSource> {
    if (!(input instanceof Blob)) throw new MediaBrowserUploadError("media_upload_file_invalid", "上傳檔案格式無效。");
    return {
      size: input.size,
      async slice(start, end) {
        const part = input.slice(start, end);
        const value = Object.assign(new Uint8Array(await part.arrayBuffer()), { size: part.size });
        return {
          value,
          done: end >= input.size,
        };
      },
      close() {},
    };
  },
};

function isExactRetryPolicy(value: readonly number[]): boolean {
  return value.length === TUS_RETRY_DELAYS.length
    && value.every((delay, index) => delay === TUS_RETRY_DELAYS[index]);
}

function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const isHostedSupabase = url.protocol === "https:"
      && url.hostname.endsWith(".storage.supabase.co")
      && url.pathname === TUS_ENDPOINT_PATH;
    const localMatch = endpoint.match(LOCAL_TUS_ENDPOINT);
    const localPort = localMatch ? Number(localMatch[1]) : 0;
    const isExactLocalDevelopment = localMatch !== null && localPort <= 65_535;
    return (isHostedSupabase || isExactLocalDevelopment)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function assertGrant(grant: UploadGrant, file: Blob, now: Date): void {
  const upload = grant.upload;
  const expectedFingerprint = `puizeru:${grant.ingestId}:${upload.metadata.objectName}`;
  const expectedObjectPath = new RegExp(`^originals/${grant.assetId}/${UUID_V4}$`, "i");
  if (
    grant.status !== "upload_grant"
    || !(new RegExp(`^${UUID_V4}$`, "i")).test(grant.ingestId)
    || !(new RegExp(`^${UUID_V4}$`, "i")).test(grant.assetId)
    || upload.protocol !== "tus"
    || !isAllowedEndpoint(upload.endpoint)
    || !hasExactKeys(upload.headers, ["x-signature"])
    || typeof upload.headers["x-signature"] !== "string"
    || upload.headers["x-signature"].length === 0
    || !hasExactKeys(upload.metadata, ["bucketName", "cacheControl", "contentType", "objectName"])
    || upload.metadata.bucketName !== "game-media"
    || upload.metadata.cacheControl !== "0"
    || !upload.metadata.contentType
    || !expectedObjectPath.test(upload.metadata.objectName)
    || upload.chunkSize !== TUS_CHUNK_SIZE
    || !isExactRetryPolicy(upload.retryDelays)
    || upload.uploadDataDuringCreation !== true
    || upload.resumeFromPreviousUpload !== true
    || upload.removeFingerprintOnSuccess !== true
    || upload.upsert !== false
    || upload.fingerprint !== expectedFingerprint
    || !Number.isSafeInteger(upload.declaredByteSize)
    || !Number.isSafeInteger(upload.maxByteSize)
    || upload.maxByteSize !== MEDIA_MAX_BYTES
    || upload.declaredByteSize <= 0
    || upload.declaredByteSize > upload.maxByteSize
    || Number.isNaN(Date.parse(grant.expiresAt))
    || Date.parse(grant.expiresAt) <= now.getTime()
  ) {
    throw new MediaBrowserUploadError("media_upload_grant_invalid", "上傳授權資料無效或已過期。");
  }
  if (file.size !== upload.declaredByteSize) {
    throw new MediaBrowserUploadError("media_upload_file_invalid", "檔案大小與上傳授權不一致。");
  }
}

function sameMetadata(actual: Record<string, string>, expected: UploadGrant["upload"]["metadata"]): boolean {
  return hasExactKeys(actual, ["bucketName", "cacheControl", "contentType", "objectName"])
    && actual.bucketName === expected.bucketName
    && actual.cacheControl === expected.cacheControl
    && actual.contentType === expected.contentType
    && actual.objectName === expected.objectName;
}

function isSafePreviousUpload(previous: BrowserPreviousUpload, grant: UploadGrant): boolean {
  if (previous.size !== grant.upload.declaredByteSize || !sameMetadata(previous.metadata, grant.upload.metadata)) return false;
  if (Number.isNaN(Date.parse(previous.creationTime))) return false;
  if (typeof previous.uploadUrl !== "string" || previous.parallelUploadUrls !== null) return false;
  try {
    const endpoint = new URL(grant.upload.endpoint);
    const uploadUrl = new URL(previous.uploadUrl);
    return uploadUrl.origin === endpoint.origin
      && uploadUrl.pathname.startsWith(`${endpoint.pathname}/`)
      && !uploadUrl.username
      && !uploadUrl.password
      && !uploadUrl.search
      && !uploadUrl.hash;
  } catch {
    return false;
  }
}

function newestPreviousUpload(previous: BrowserPreviousUpload[]): BrowserPreviousUpload | undefined {
  return [...previous].sort((left, right) => Date.parse(right.creationTime) - Date.parse(left.creationTime))[0];
}

export function createBrowserMediaUpload(input: Readonly<{
  grant: UploadGrant;
  file: Blob;
  urlStorage?: BrowserUploadUrlStorage;
  httpStack?: HttpStack;
  now?: () => Date;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}>): BrowserMediaUploadTask {
  let upload: Upload | undefined;
  let settled = false;
  let cancelled = false;
  let resolveCompletion!: (result: BrowserMediaUploadResult) => void;
  const completion = new Promise<BrowserMediaUploadResult>((resolve) => { resolveCompletion = resolve; });
  const settle = (result: BrowserMediaUploadResult) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };

  void (async () => {
    try {
      assertGrant(input.grant, input.file, (input.now ?? (() => new Date()))());
      if (cancelled) return;
      const backingStorage = (input.urlStorage ?? defaultOptions.urlStorage) as BrowserUploadUrlStorage;
      let fingerprintRemoval: Promise<void> | undefined;
      const urlStorage: BrowserUploadUrlStorage = {
        findAllUploads: () => backingStorage.findAllUploads(),
        findUploadsByFingerprint: (fingerprint) => backingStorage.findUploadsByFingerprint(fingerprint),
        addUpload: (fingerprint, previousUpload) => backingStorage.addUpload(fingerprint, previousUpload),
        removeUpload(urlStorageKey) {
          fingerprintRemoval = backingStorage.removeUpload(urlStorageKey);
          return fingerprintRemoval;
        },
      };
      upload = new Upload(input.file, {
        endpoint: input.grant.upload.endpoint,
        headers: { "x-signature": input.grant.upload.headers["x-signature"] },
        metadata: { ...input.grant.upload.metadata },
        chunkSize: input.grant.upload.chunkSize,
        retryDelays: [...input.grant.upload.retryDelays],
        uploadDataDuringCreation: input.grant.upload.uploadDataDuringCreation,
        removeFingerprintOnSuccess: input.grant.upload.removeFingerprintOnSuccess,
        storeFingerprintForResuming: true,
        fingerprint: async () => input.grant.upload.fingerprint,
        fileReader: blobFileReader,
        urlStorage,
        ...(input.httpStack ? { httpStack: input.httpStack } : {}),
        onProgress: input.onProgress ?? null,
        onSuccess: () => {
          void (fingerprintRemoval ?? Promise.resolve())
            .then(() => settle({ status: "uploaded" }))
            .catch(() => settle({
              status: "failed",
              error: new MediaBrowserUploadError("media_upload_failed", "檔案上傳失敗，請稍後重試。"),
            }));
        },
        onError: () => settle({
          status: "failed",
          error: new MediaBrowserUploadError("media_upload_failed", "檔案上傳失敗，請稍後重試。"),
        }),
      });
      const previous = input.grant.upload.resumeFromPreviousUpload
        ? (await upload.findPreviousUploads()).filter((entry) => isSafePreviousUpload(entry, input.grant))
        : [];
      if (cancelled) return;
      const resumable = newestPreviousUpload(previous);
      if (resumable) upload.resumeFromPreviousUpload(resumable);
      upload.start();
    } catch (error) {
      settle({
        status: "failed",
        error: error instanceof MediaBrowserUploadError
          ? error
          : new MediaBrowserUploadError("media_upload_failed", "檔案上傳失敗，請稍後重試。"),
      });
    }
  })();

  return {
    completion,
    async cancel() {
      if (settled) return;
      cancelled = true;
      await upload?.abort(false);
      settle({ status: "cancelled" });
    },
  };
}

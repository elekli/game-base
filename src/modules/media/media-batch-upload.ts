export type MediaBatchStatus = "queued" | "uploading" | "processing" | "succeeded" | "failed" | "cancelled";

export type MediaBatchFile = Readonly<{
  idempotencyKey: string;
  file: Blob & Readonly<{ name: string; type: string; size: number; lastModified?: number }>;
  purpose: "gallery_image" | "custom_cover" | "attachment";
  status: MediaBatchStatus;
  uploadedBytes: number;
  error: string | null;
  assetId: string | null;
  thumbnailState: "pending" | "processing" | "ready" | "failed" | null;
}>;

export type MediaBatchUploader = (input: Readonly<{
  idempotencyKey: string;
  file: MediaBatchFile["file"];
  purpose: MediaBatchFile["purpose"];
  onProgress(uploadedBytes: number): void;
  onProcessing(): void;
  registerCancel(cancel: () => Promise<void>): void;
}>) => Promise<Readonly<{
  assetId: string;
  thumbnailState: MediaBatchFile["thumbnailState"];
}>>;

type Listener = (files: readonly MediaBatchFile[]) => void;
export type MediaBatchIdentityStore = Readonly<{
  find(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"]): string | null;
  remember(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"], idempotencyKey: string): void;
  forget?(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"], idempotencyKey: string): void;
  discard?(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"]): void;
}>;

export function createSessionMediaIdentityStore(namespace: string): MediaBatchIdentityStore {
  const fallback = new Map<string, string>();
  let warned = false;
  const warnUnavailable = () => {
    if (warned || typeof window === "undefined") return;
    warned = true;
    console.warn("media_upload_identity_persistence_unavailable");
  };
  const signature = (file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"]) => JSON.stringify([namespace, purpose, file.name, file.size, file.type, file.lastModified ?? null]);
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem("puizeru:media-upload-identities") ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
        if (typeof value === "string") return [[key, value]];
        if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return [[key, value[0]]];
        return [];
      }));
    }
    catch { warnUnavailable(); return Object.fromEntries(fallback); }
  };
  return {
    find(file, purpose) { return read()[signature(file, purpose)] ?? fallback.get(signature(file, purpose)) ?? null; },
    remember(file, purpose, key) {
      const id = signature(file, purpose);
      fallback.set(id, key);
      try { sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify({ ...read(), [id]: key })); } catch { warnUnavailable(); }
    },
    forget(file, purpose, key) {
      const id = signature(file, purpose);
      if (fallback.get(id) === key) fallback.delete(id);
      try {
        const stored = read();
        if (stored[id] === key) delete stored[id];
        sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify(stored));
      } catch { warnUnavailable(); }
    },
    discard(file, purpose) {
      const id = signature(file, purpose);
      fallback.delete(id);
      try {
        const stored = read();
        delete stored[id];
        sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify(stored));
      } catch { warnUnavailable(); }
    },
  };
}

/**
 * Browser batch state model. Network transport remains behind `upload`, so this
 * public seam can prove scheduling and idempotency independently from React.
 *
 * selected → queued → uploading → processing → succeeded
 *                           └───────────────→ failed → retry(same key)
 * queued/uploading/processing ─────────────→ cancelled
 */
export function createMediaBatchUpload(input: Readonly<{
  upload: MediaBatchUploader;
  createId?: (file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"]) => string;
  identityStore?: MediaBatchIdentityStore;
  concurrency?: number;
}>) {
  const concurrency = input.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("media_batch_concurrency_invalid");
  const createId = input.createId ?? (() => crypto.randomUUID());
  let files: MediaBatchFile[] = [];
  let running: Promise<void> | null = null;
  let cancelled = false;
  const activeCancels = new Map<string, () => Promise<void>>();
  const cancelSignals = new Map<string, (error: Error) => void>();
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((listener) => listener(files));
  const update = (key: string, patch: Partial<MediaBatchFile>) => {
    files = files.map((item) => item.idempotencyKey === key ? { ...item, ...patch } : item);
    emit();
  };

  async function runOne(item: MediaBatchFile) {
    if (cancelled || item.status !== "queued") return;
    update(item.idempotencyKey, { status: "uploading", error: null });
    try {
      const cancellation = new Promise<never>((_resolve, reject) => cancelSignals.set(item.idempotencyKey, reject));
      const result = await Promise.race([input.upload({
        idempotencyKey: item.idempotencyKey,
        file: item.file,
        purpose: item.purpose,
        onProgress: (uploadedBytes) => update(item.idempotencyKey, { uploadedBytes }),
        onProcessing: () => update(item.idempotencyKey, { status: "processing" }),
        registerCancel: (cancel) => activeCancels.set(item.idempotencyKey, cancel),
      }), cancellation]);
      if (cancelled) update(item.idempotencyKey, { status: "cancelled" });
      else {
        input.identityStore?.forget?.(item.file, item.purpose, item.idempotencyKey);
        update(item.idempotencyKey, { status: "succeeded", assetId: result.assetId, thumbnailState: result.thumbnailState });
      }
    } catch (error) {
      const cancelFailed = error instanceof Error && error.message === "media_upload_cancel_failed";
      update(item.idempotencyKey, {
        status: cancelFailed ? "failed" : cancelled ? "cancelled" : "failed",
        error: cancelFailed ? "暫停上傳失敗，請重新整理後確認狀態。" : cancelled ? null : error instanceof Error ? error.message : "檔案上傳失敗，請重試。",
      });
    } finally { activeCancels.delete(item.idempotencyKey); cancelSignals.delete(item.idempotencyKey); }
  }

  async function drain() {
    const workers = Array.from({ length: concurrency }, async () => {
      while (!cancelled) {
        const next = files.find((item) => item.status === "queued");
        if (!next) return;
        await runOne(next);
      }
    });
    await Promise.all(workers);
  }

  const start = () => {
    if (running) return running;
    cancelled = false;
    running = drain().finally(() => { running = null; });
    return running;
  };

  return {
    add(selected: readonly MediaBatchFile["file"][], purpose: MediaBatchFile["purpose"] = "gallery_image") {
      const activeKeys = new Set(files.filter((item) => ["queued", "uploading", "processing"].includes(item.status)).map((item) => item.idempotencyKey));
      const signatures = selected.map((file) => JSON.stringify([purpose, file.name, file.size, file.type, file.lastModified ?? null]));
      const ambiguous = new Set(signatures.filter((signature, index) => signatures.indexOf(signature) !== index || signatures.lastIndexOf(signature) !== index));
      if (ambiguous.size) console.warn("media_upload_identity_ambiguous");
      files = [...files, ...selected.flatMap((file) => {
        const signature = JSON.stringify([purpose, file.name, file.size, file.type, file.lastModified ?? null]);
        const persistIdentity = !ambiguous.has(signature);
        if (!persistIdentity) input.identityStore?.discard?.(file, purpose);
        const idempotencyKey = (persistIdentity ? input.identityStore?.find(file, purpose) : null) ?? createId(file, purpose);
        if (activeKeys.has(idempotencyKey)) return [];
        activeKeys.add(idempotencyKey);
        if (persistIdentity) input.identityStore?.remember(file, purpose, idempotencyKey);
        return [{ idempotencyKey, file, purpose, status: "queued" as const, uploadedBytes: 0,
          error: null, assetId: null, thumbnailState: null }];
      })];
      emit();
    },
    start,
    retryFailed() {
      files = files.map((item) => item.status === "failed" ? { ...item, status: "queued", error: null } : item);
      emit();
      return start();
    },
    async cancel() {
      cancelled = true;
      const entries = [...activeCancels.entries()];
      const results = await Promise.allSettled(entries.map(([, cancel]) => cancel()));
      const failedKeys = new Set(results.flatMap((result, index) => result.status === "rejected" ? [entries[index]![0]] : []));
      for (const [key, reject] of cancelSignals) reject(new Error(failedKeys.has(key) ? "media_upload_cancel_failed" : "media_upload_cancelled"));
      files = files.map((item) => ["queued", "uploading", "processing"].includes(item.status) ? {
        ...item,
        status: failedKeys.has(item.idempotencyKey) ? "failed" : "cancelled",
        error: failedKeys.has(item.idempotencyKey) ? "暫停上傳失敗，請重新整理後確認狀態。" : null,
      } : item);
      emit();
      if (failedKeys.size) throw new Error("media_upload_cancel_failed");
    },
    snapshot: () => files,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

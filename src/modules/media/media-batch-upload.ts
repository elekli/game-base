export type MediaBatchStatus = "queued" | "uploading" | "processing" | "succeeded" | "failed" | "cancelled";

export type MediaBatchFile = Readonly<{
  idempotencyKey: string;
  file: Blob & Readonly<{ name: string; type: string; size: number; lastModified?: number }>;
  purpose: "gallery_image" | "custom_cover" | "attachment";
  identity: string;
  status: MediaBatchStatus;
  uploadedBytes: number;
  error: string | null;
  assetId: string | null;
  thumbnailState: "pending" | "processing" | "ready" | "failed" | null;
  retryable: boolean;
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
  find(identity: string, occurrence: number): string | null;
  remember(identity: string, idempotencyKey: string): void;
  forget?(identity: string, idempotencyKey: string): void;
}>;

export function createSessionMediaIdentityStore(namespace: string): MediaBatchIdentityStore {
  const fallback = new Map<string, string>();
  let warned = false;
  const warnUnavailable = () => {
    if (warned || typeof window === "undefined") return;
    warned = true;
    console.warn("media_upload_identity_persistence_unavailable");
  };
  const storageKey = (identity: string) => JSON.stringify([namespace, identity]);
  const fallbackValues = (id: string) => [...fallback.entries()]
    .filter(([key]) => key.startsWith(`${id}:`))
    .sort(([left], [right]) => Number(left.slice(id.length + 1)) - Number(right.slice(id.length + 1)))
    .map(([, value]) => value);
  const read = (): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem("puizeru:media-upload-identities") ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
        if (typeof value === "string") return [[key, [value]]];
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [[key, value]];
        return [];
      }));
    }
    catch { warnUnavailable(); return {}; }
  };
  return {
    find(identity, occurrence) { const id = storageKey(identity); return read()[id]?.[occurrence] ?? fallback.get(`${id}:${occurrence}`) ?? null; },
    remember(identity, key) {
      const id = storageKey(identity);
      const existing = read()[id] ?? fallbackValues(id);
      if (existing.includes(key)) return;
      fallback.set(`${id}:${existing.length}`, key);
      try { sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify({ ...read(), [id]: [...existing, key] })); } catch { warnUnavailable(); }
    },
    forget(identity, key) {
      const id = storageKey(identity);
      for (const candidate of [...fallback.keys()]) if (fallback.get(candidate) === key) fallback.delete(candidate);
      try {
        const stored = read();
        const remaining = (stored[id] ?? []).filter((candidate) => candidate !== key);
        if (remaining.length) stored[id] = remaining; else delete stored[id];
        sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify(stored));
      } catch { warnUnavailable(); }
    },
  };
}

async function contentIdentity(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify([purpose, file.name, file.size, file.type, file.lastModified ?? null, hash]);
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
        input.identityStore?.forget?.(item.identity, item.idempotencyKey);
        update(item.idempotencyKey, { status: "succeeded", assetId: result.assetId, thumbnailState: result.thumbnailState });
      }
    } catch (error) {
      const cancelFailed = error instanceof Error && error.message === "media_upload_cancel_failed";
      const retryable = cancelFailed || (typeof error !== "object" || error === null || !("retryable" in error) || error.retryable !== false);
      if (!retryable) input.identityStore?.forget?.(item.identity, item.idempotencyKey);
      update(item.idempotencyKey, {
        status: cancelFailed ? "failed" : cancelled ? "cancelled" : "failed",
        error: cancelFailed ? "暫停上傳失敗，請重新整理後確認狀態。" : cancelled ? null : error instanceof Error ? error.message : "檔案上傳失敗，請重試。",
        retryable,
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
    async add(selected: readonly MediaBatchFile["file"][], purpose: MediaBatchFile["purpose"] = "gallery_image") {
      const activeKeys = new Set(files.map((item) => item.idempotencyKey));
      const prepared: Array<Readonly<{ file: MediaBatchFile["file"]; identity: string }>> = [];
      for (const file of selected) prepared.push({ file, identity: await contentIdentity(file, purpose) });
      const occurrences = new Map<string, number>();
      files = [...files, ...prepared.flatMap(({ file, identity }) => {
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const idempotencyKey = input.identityStore?.find(identity, occurrence) ?? createId(file, purpose);
        if (activeKeys.has(idempotencyKey)) return [];
        activeKeys.add(idempotencyKey);
        input.identityStore?.remember(identity, idempotencyKey);
        return [{ idempotencyKey, identity, file, purpose, status: "queued" as const, uploadedBytes: 0,
          error: null, assetId: null, thumbnailState: null, retryable: true }];
      })];
      emit();
    },
    reject(selected: readonly Readonly<{ file: MediaBatchFile["file"]; error: string }>[], purpose: MediaBatchFile["purpose"] = "gallery_image") {
      files = [...files, ...selected.map(({ file, error }) => ({
        idempotencyKey: createId(file, purpose), identity: "", file, purpose,
        status: "failed" as const, uploadedBytes: 0, error, assetId: null,
        thumbnailState: null, retryable: false,
      }))];
      emit();
    },
    start,
    retryFailed() {
      files = files.map((item) => item.status === "failed" && item.retryable ? { ...item, status: "queued", error: null } : item);
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
        retryable: failedKeys.has(item.idempotencyKey),
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

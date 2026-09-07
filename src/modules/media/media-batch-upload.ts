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
  find(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"], occurrence?: number): string | null;
  remember(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"], idempotencyKey: string): void;
  forget?(file: MediaBatchFile["file"], purpose: MediaBatchFile["purpose"], idempotencyKey: string): void;
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
  const read = (): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem("puizeru:media-upload-identities") ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
        if (typeof value === "string") return [[key, [value]]];
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [[key, value]];
        return [];
      }));
    }
    catch { warnUnavailable(); return Object.fromEntries([...fallback.entries()].map(([key, value]) => [key.replace(/:[0-9]+$/, ""), [value]])); }
  };
  return {
    find(file, purpose, occurrence = 0) { return read()[signature(file, purpose)]?.[occurrence] ?? fallback.get(`${signature(file, purpose)}:${occurrence}`) ?? null; },
    remember(file, purpose, key) {
      const id = signature(file, purpose);
      const existing = read()[id] ?? [];
      if (existing.includes(key)) return;
      fallback.set(`${id}:${existing.length}`, key);
      try { sessionStorage.setItem("puizeru:media-upload-identities", JSON.stringify({ ...read(), [id]: [...existing, key] })); } catch { warnUnavailable(); }
    },
    forget(file, purpose, key) {
      const id = signature(file, purpose);
      for (const fallbackKey of [...fallback.keys()]) if (fallback.get(fallbackKey) === key) fallback.delete(fallbackKey);
      try {
        const stored = read();
        const remaining = (stored[id] ?? []).filter((candidate) => candidate !== key);
        if (remaining.length) stored[id] = remaining; else delete stored[id];
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
      const result = await input.upload({
        idempotencyKey: item.idempotencyKey,
        file: item.file,
        purpose: item.purpose,
        onProgress: (uploadedBytes) => update(item.idempotencyKey, { uploadedBytes }),
        onProcessing: () => update(item.idempotencyKey, { status: "processing" }),
        registerCancel: (cancel) => activeCancels.set(item.idempotencyKey, cancel),
      });
      if (cancelled) update(item.idempotencyKey, { status: "cancelled" });
      else {
        input.identityStore?.forget?.(item.file, item.purpose, item.idempotencyKey);
        update(item.idempotencyKey, { status: "succeeded", assetId: result.assetId, thumbnailState: result.thumbnailState });
      }
    } catch (error) {
      update(item.idempotencyKey, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : error instanceof Error ? error.message : "檔案上傳失敗，請重試。",
      });
    } finally { activeCancels.delete(item.idempotencyKey); }
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
      const occurrences = new Map<string, number>();
      files = [...files, ...selected.flatMap((file) => {
        const signature = JSON.stringify([purpose, file.name, file.size, file.type, file.lastModified ?? null]);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        const idempotencyKey = input.identityStore?.find(file, purpose, occurrence) ?? createId(file, purpose);
        if (activeKeys.has(idempotencyKey)) return [];
        activeKeys.add(idempotencyKey);
        input.identityStore?.remember(file, purpose, idempotencyKey);
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
      await Promise.allSettled([...activeCancels.values()].map((cancel) => cancel()));
      files = files.map((item) => ["queued", "uploading", "processing"].includes(item.status) ? { ...item, status: "cancelled" } : item);
      emit();
    },
    snapshot: () => files,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

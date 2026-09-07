"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  MEDIA_MAX_BYTES,
  createMediaBatchUpload,
  createSessionMediaIdentityStore,
  type MediaBatchFile,
  type MediaGallery,
  type MediaGalleryItem,
  type MediaPurpose,
  type UploadGrant,
} from "@/modules/media";
import { createBrowserMediaUpload } from "@/modules/media/browser-upload-client";

type JsonError = Readonly<{ message?: string }>;
class MediaClientError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "MediaClientError"; }
}
const statusLabel: Record<MediaBatchFile["status"], string> = {
  queued: "等待中", uploading: "上傳中", processing: "確認原檔中", succeeded: "原檔已保存",
  failed: "上傳失敗", cancelled: "已暫停",
};

async function responseJson<T>(response: Response): Promise<T> {
  let body: T | JsonError;
  try { body = await response.json() as T; }
  catch { throw new Error("伺服器回應格式無效，請稍後重試。"); }
  if (!response.ok) throw new MediaClientError((body as JsonError).message ?? "媒體操作失敗，請重試。", response.status !== 400);
  return body as T;
}

async function finalize(key: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch("/api/private/media/uploads/finalize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: key }),
    });
    const result = await responseJson<{ status?: "finalizing"; asset?: { id: string }; thumbnail?: { state: "pending" | "processing" | "ready" | "failed" } | null }>(response);
    if (result.asset) return { assetId: result.asset.id, thumbnailState: result.thumbnail?.state ?? null };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("原檔仍在確認中。請保留本頁，稍後只重試這個檔案。");
}

function Thumbnail({ item, onError }: Readonly<{ item: MediaGalleryItem; onError?: () => void }>) {
  if (item.thumbnailUrl) return <Image unoptimized onError={onError} src={item.thumbnailUrl} alt={item.asset.caption || item.asset.originalFileName} width={item.asset.width ?? 640} height={item.asset.height ?? 480} loading="lazy" className="h-full min-h-36 w-full bg-emerald-800 object-cover" />;
  const failed = item.thumbnail?.state === "failed";
  const unavailable = item.thumbnailError === "media_thumbnail_read_unavailable";
  return <div className={`flex min-h-36 flex-col items-center justify-center gap-2 px-4 text-center ${failed || unavailable ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-900"}`}><span aria-hidden className="text-3xl">{failed || unavailable ? "△" : "◌"}</span><span className="text-sm font-semibold">{unavailable ? "縮圖暫時無法讀取" : failed ? "縮圖處理失敗" : "縮圖處理中"}</span><span className="text-xs">原檔已安全保存</span></div>;
}

export function MediaGalleryClient({ gameId }: Readonly<{ gameId: string }>) {
  const router = useRouter();
  const [gallery, setGallery] = useState<MediaGallery | null>(null);
  const [files, setFiles] = useState<readonly MediaBatchFile[]>([]);
  const [purpose, setPurpose] = useState<MediaPurpose>("gallery_image");
  const [message, setMessage] = useState("");
  const [galleryError, setGalleryError] = useState("");
  const [uploadSummary, setUploadSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoAssetIds, setUndoAssetIds] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<Readonly<{ url: string; name: string; download: () => Promise<void> }> | null>(null);
  const galleryLoad = useRef<Promise<boolean> | null>(null);
  const [batch] = useState(() => createMediaBatchUpload({
    identityStore: createSessionMediaIdentityStore(gameId),
    async upload({ idempotencyKey, file, purpose: filePurpose, onProgress, onProcessing, registerCancel }) {
      const beginAbort = new AbortController();
      let transport: ReturnType<typeof createBrowserMediaUpload> | null = null;
      registerCancel(async () => { beginAbort.abort(); await transport?.cancel(); });
      const beginResponse = await fetch("/api/private/media/uploads/begin", {
        method: "POST", headers: { "content-type": "application/json" },
        signal: beginAbort.signal, body: JSON.stringify({ idempotencyKey, gameId, purpose: filePurpose, originalFileName: file.name, declaredMimeType: file.type || "application/octet-stream", declaredByteSize: file.size }),
      });
      const begun = await responseJson<UploadGrant | { status: "finalizing" } | { status: "already_finalized"; result: { asset: { id: string }; thumbnail: { state: "pending" | "processing" | "ready" | "failed" } | null } }>(beginResponse);
      if (begun.status === "already_finalized") return { assetId: begun.result.asset.id, thumbnailState: begun.result.thumbnail?.state ?? null };
      if (begun.status === "finalizing") { onProcessing(); return finalize(idempotencyKey); }
      if (beginAbort.signal.aborted) throw new Error("上傳已暫停，可稍後續傳。");
      transport = createBrowserMediaUpload({ grant: begun, file, onProgress: (uploaded) => onProgress(uploaded) });
      const result = await transport.completion;
      if (result.status !== "uploaded") throw new Error(result.status === "cancelled" ? "上傳已暫停，可稍後續傳。" : result.error.message);
      onProcessing();
      return finalize(idempotencyKey);
    },
  }));

  function loadGallery(): Promise<boolean> {
    if (galleryLoad.current) return galleryLoad.current;
    const request = (async () => {
      try {
        const response = await fetch(`/api/private/media/games/${gameId}`, { cache: "no-store" });
        setGallery(await responseJson<MediaGallery>(response));
        setGalleryError("");
        return true;
      } catch (error) { setGalleryError(error instanceof Error ? error.message : "相簿讀取失敗。"); return false; }
    })();
    galleryLoad.current = request;
    void request.finally(() => { if (galleryLoad.current === request) galleryLoad.current = null; });
    return request;
  }

  useEffect(() => {
    const unsubscribe = batch.subscribe(setFiles);
    void fetch(`/api/private/media/games/${gameId}`, { cache: "no-store" })
      .then((response) => responseJson<MediaGallery>(response))
      .then((next) => { setGallery(next); setGalleryError(""); }, (error) => setGalleryError(error instanceof Error ? error.message : "相簿讀取失敗。"));
    const warnOnLeave = (event: BeforeUnloadEvent) => {
      if (batch.snapshot().some((item) => ["queued", "uploading", "processing"].includes(item.status))) event.preventDefault();
    };
    window.addEventListener("beforeunload", warnOnLeave);
    return () => { batch.cancel().catch((error) => console.error("media_upload_cancel_failed", error)); unsubscribe(); window.removeEventListener("beforeunload", warnOnLeave); };
  }, [batch, gameId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const active = files.filter((file) => ["queued", "uploading", "processing"].includes(file.status)).length;
      const succeeded = files.filter((file) => file.status === "succeeded").length;
      const failed = files.filter((file) => file.status === "failed").length;
      setUploadSummary(`批次狀態：${active} 個處理中、${succeeded} 個已保存、${failed} 個失敗。`);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [files]);

  async function chooseFiles(selected: FileList | null) {
    if (!selected?.length) return;
    const selectedPurpose = purpose;
    const candidates = selectedPurpose === "custom_cover" ? [...selected].slice(0, 1) : [...selected];
    const accepted = candidates.filter((file) => file.size > 0 && file.size <= MEDIA_MAX_BYTES);
    const rejected = candidates.flatMap((file) => file.size > 0 && file.size <= MEDIA_MAX_BYTES ? [] : [{
      file,
      error: file.size === 0 ? "空檔案不會上傳，請重新選取。" : "超過 50 MB 上限，不會上傳。",
    }]);
    if (rejected.length) batch.reject(rejected, selectedPurpose);
    if (!accepted.length) return;
    try {
      setMessage("正在確認檔案內容……");
      await batch.add(accepted, selectedPurpose);
      setMessage("批次已開始；離開頁面前請等候原檔保存完成。");
      await batch.start();
      await loadGallery();
      if (selectedPurpose === "custom_cover") router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "無法確認檔案內容，請重新選取。");
    }
  }

  async function action(run: () => Promise<void>, pending: string, onCommitted?: () => void) {
    if (busy) return false;
    setBusy(true); setMessage(pending);
    try {
      await run();
      onCommitted?.();
      if (await loadGallery()) { setMessage("已完成。"); return true; }
      setMessage("已儲存，但重新整理相簿失敗；目前輸入內容已保留。");
      return false;
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失敗，請重試。"); return false; }
    finally { setBusy(false); }
  }

  async function post(path: string, body: unknown = {}) {
    await responseJson(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async function download(item: MediaGalleryItem) {
    await action(async () => {
      const read = await responseJson<{ url: string }>(await fetch(`/api/private/media/assets/${item.asset.id}/original?disposition=attachment`, { cache: "no-store" }));
      window.location.assign(read.url);
    }, "正在核發 60 秒下載網址……");
  }

  async function previewOriginal(item: MediaGalleryItem) {
    await action(async () => {
      const read = await responseJson<{ url: string }>(await fetch(`/api/private/media/assets/${item.asset.id}/original?disposition=inline`, { cache: "no-store" }));
      setPreview({ url: read.url, name: item.asset.originalFileName, download: () => download(item) });
    }, "正在核發 60 秒預覽網址……");
  }

  async function remove(item: MediaGalleryItem) {
    await action(
      () => post(`/api/private/media/assets/${item.asset.id}/remove`),
      "正在移除媒體……",
      () => {
        setUndoAssetIds((current) => [...current.filter((assetId) => assetId !== item.asset.id), item.asset.id]);
        setGallery((current) => current ? {
          ...current,
          manualCoverAssetId: current.manualCoverAssetId === item.asset.id ? null : current.manualCoverAssetId,
          items: current.items.filter((candidate) => candidate.asset.id !== item.asset.id),
        } : current);
        router.refresh();
      },
    );
  }

  const failedCount = files.filter((file) => file.status === "failed" && file.retryable).length;
  const undoAssetId = undoAssetIds.at(-1) ?? null;
  const images = gallery?.items.filter((item) => item.asset.purpose !== "attachment") ?? [];
  const attachments = gallery?.items.filter((item) => item.asset.purpose === "attachment") ?? [];

  return <section aria-labelledby="media-heading" className="mt-10 overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-[#fffdf6] shadow-[0_24px_60px_-42px_rgba(6,78,59,.65)]">
    <header className="border-b border-emerald-950/10 bg-[linear-gradient(135deg,#e8f3e9_0%,#fff7db_100%)] px-5 py-6">
      <p className="text-xs font-bold tracking-[.22em] text-emerald-800">私人媒體櫃</p>
      <h2 id="media-heading" className="mt-2 text-2xl font-semibold text-emerald-950">照片與遊戲附件</h2>
      <p className="mt-2 max-w-prose text-sm leading-6 text-emerald-950/70">原檔保存在私人空間；相簿只載入縮圖，下載網址約 60 秒後失效。</p>
    </header>

    <div className="px-4 py-5 sm:px-6">
      <fieldset className="grid grid-cols-3 gap-2" disabled={files.some((file) => ["queued", "uploading", "processing"].includes(file.status))}>
        <legend className="mb-2 text-sm font-semibold">這批檔案要放在哪裡？</legend>
        {([['gallery_image', '相簿照片'], ['custom_cover', '自訂封面'], ['attachment', '遊戲附件']] as const).map(([value, label]) => <label key={value} className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-2 text-center text-sm font-semibold focus-within:ring-2 focus-within:ring-emerald-700 ${purpose === value ? "border-emerald-800 bg-emerald-900 text-white" : "border-emerald-950/15 bg-white text-emerald-950"}`}><input className="sr-only" type="radio" name="media-purpose" checked={purpose === value} onChange={() => setPurpose(value)} />{label}</label>)}
      </fieldset>
      <label className="mt-3 flex min-h-14 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-emerald-700 bg-emerald-50 px-4 text-center font-semibold text-emerald-950 hover:bg-emerald-100 focus-within:ring-2 focus-within:ring-emerald-700">
        <input className="sr-only" type="file" multiple={purpose !== "custom_cover"} accept={purpose === "attachment" ? undefined : "image/png,image/jpeg,image/gif,image/webp"} onChange={(event) => { void chooseFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
        {purpose === "custom_cover" ? "選取一個封面檔案" : "選取多個檔案"} <span className="ml-2 text-xs font-normal">每檔上限 50 MB</span>
      </label>

      {files.length > 0 && <div aria-label="批次上傳狀態" className="mt-4 space-y-2">{files.map((file) => <div key={file.idempotencyKey} className="rounded-xl border border-stone-200 bg-white p-3"><div className="flex items-start justify-between gap-3"><span className="min-w-0 truncate text-sm font-medium">{file.file.name}</span><span className={`shrink-0 text-xs font-bold ${file.status === "failed" ? "text-rose-700" : file.status === "succeeded" ? "text-emerald-700" : "text-amber-700"}`}>{statusLabel[file.status]}</span></div>{file.status === "uploading" && <progress aria-label={`${file.file.name} 上傳進度`} className="mt-2 h-2 w-full accent-emerald-700" max={file.file.size} value={file.uploadedBytes} />}{file.error && <p role="alert" className="mt-2 text-xs text-rose-700">{file.error}</p>}</div>)}</div>}
      {files.length > 0 && <p aria-live="polite" className="sr-only">{uploadSummary}</p>}
      {failedCount > 0 && <button className="mt-3 min-h-12 w-full rounded-xl bg-rose-700 px-4 font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void batch.retryFailed().then(loadGallery)}>只重試 {failedCount} 個失敗檔案</button>}
      {message && <p aria-live="polite" className="mt-3 rounded-xl bg-stone-100 px-3 py-2 text-sm text-stone-700">{message}</p>}
      {galleryError && <div role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{galleryError}<button className="ml-2 underline" onClick={() => void loadGallery()}>重新載入相簿</button></div>}
    </div>

    <div className="border-t border-emerald-950/10 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">相簿</h3><p className="text-xs text-stone-500">最新上傳排在前面</p></div>{gallery?.manualCoverAssetId && <button disabled={busy} className="min-h-11 rounded-xl border border-emerald-800 px-3 text-sm font-semibold text-emerald-900" onClick={() => void action(() => post(`/api/private/media/games/${gameId}/cover`, { mode: "source" }), "正在恢復來源封面……", () => router.refresh())}>恢復來源封面</button>}</div>
      {images.length === 0 ? <p className="mt-4 rounded-2xl bg-stone-100 px-4 py-8 text-center text-sm text-stone-600">還沒有相簿照片。一次選取多張，系統會逐檔保存。</p> : <div className="mt-4 grid grid-cols-2 gap-3">{images.map((item) => <ImageCard key={item.asset.id} item={item} busy={busy} download={() => download(item)} preview={() => previewOriginal(item)} remove={() => remove(item)} save={(caption) => action(() => post(`/api/private/media/assets/${item.asset.id}/metadata`, { caption }), "正在儲存圖片說明……")} setCover={() => action(() => post(`/api/private/media/games/${gameId}/cover`, { mode: "manual", assetId: item.asset.id }), "正在更換封面……", () => router.refresh())} retry={() => action(() => post(`/api/private/media/assets/${item.asset.id}/retry-thumbnail`), "正在重試縮圖……")} reload={loadGallery} isCover={gallery?.manualCoverAssetId === item.asset.id} />)}</div>}
      {gallery?.sourceCover && <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-3"><p className="mb-2 text-sm font-semibold">來源封面</p><div className="h-28 overflow-hidden rounded-xl"><Thumbnail item={gallery.sourceCover} onError={() => void loadGallery()} /></div><div className="mt-2 grid grid-cols-2 gap-2"><button className="min-h-11 rounded-xl border border-emerald-800 text-xs font-semibold text-emerald-900" onClick={() => void previewOriginal(gallery.sourceCover!)}>預覽原檔</button><button className="min-h-11 rounded-xl border border-emerald-800 text-xs font-semibold text-emerald-900" onClick={() => void download(gallery.sourceCover!)}>下載原檔</button>{gallery.sourceCover.thumbnail?.state === "failed" ? <button className="min-h-11 rounded-xl border border-rose-700 text-xs font-semibold text-rose-800" onClick={() => void action(() => post(`/api/private/media/assets/${gallery.sourceCover!.asset.id}/retry-thumbnail`), "正在重試來源封面縮圖……")}>重試縮圖</button> : gallery.sourceCover.thumbnailError && <button className="min-h-11 rounded-xl border border-amber-700 text-xs font-semibold text-amber-900" onClick={() => void loadGallery()}>重新載入縮圖</button>}</div></div>}
    </div>

    <div className="border-t border-emerald-950/10 px-4 py-6 sm:px-6"><h3 className="text-lg font-semibold">遊戲附件</h3>{attachments.length === 0 ? <p className="mt-3 text-sm text-stone-600">尚未加入規則書或玩家輔助檔案。</p> : <div className="mt-3 space-y-3">{attachments.map((item) => <AttachmentCard key={item.asset.id} item={item} busy={busy} save={(body) => action(() => post(`/api/private/media/assets/${item.asset.id}/metadata`, body), "正在儲存附件說明……")} download={() => download(item)} remove={() => remove(item)} />)}</div>}</div>
    {undoAssetId && <div role="status" className="fixed inset-x-4 bottom-4 z-40 flex min-h-12 items-center justify-between gap-3 rounded-xl bg-amber-100 px-4 text-sm text-amber-950 shadow-xl sm:left-auto sm:w-96">已移除 {undoAssetIds.length} 個媒體。<button className="font-semibold underline" onClick={() => void action(() => post(`/api/private/media/assets/${undoAssetId}/restore`), "正在還原媒體……", () => setUndoAssetIds((current) => current.filter((assetId) => assetId !== undoAssetId)))}>立即還原</button></div>}
    {preview && <div role="dialog" aria-modal="true" aria-label={`${preview.name} 原檔預覽`} className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/75 p-4"><div className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-white p-4"><Image unoptimized src={preview.url} alt={preview.name} width={1200} height={900} className="max-h-[70vh] w-full object-contain" /><div className="mt-3 grid grid-cols-2 gap-2"><button className="min-h-11 rounded-xl border" onClick={() => setPreview(null)}>關閉預覽</button><button className="min-h-11 rounded-xl bg-emerald-900 text-white" onClick={() => void preview.download()}>下載原檔</button></div></div></div>}
  </section>;
}

function AttachmentCard({ item, busy, save, download, remove }: Readonly<{ item: MediaGalleryItem; busy: boolean; save(body: unknown): Promise<boolean>; download(): Promise<void>; remove(): Promise<void> }>) {
  const [displayName, setDisplayName] = useState(item.asset.displayName ?? "");
  const [description, setDescription] = useState(item.asset.description ?? "");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // Server normalization is authoritative only before the user begins a new draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!dirty) { setDisplayName(item.asset.displayName ?? ""); setDescription(item.asset.description ?? ""); }
  }, [dirty, item.asset.description, item.asset.displayName]);
  const saveDraft = async () => { if (await save({ displayName, description })) setDirty(false); };
  return <article className="rounded-2xl border border-stone-200 bg-white p-4"><p className="truncate text-sm font-semibold">{item.asset.displayName || item.asset.originalFileName}</p><p className="mt-1 text-xs text-stone-500">{item.asset.originalFileName}</p><label className="mt-3 block text-xs font-semibold">顯示名稱<input value={displayName} maxLength={255} onChange={(event) => { setDirty(true); setDisplayName(event.target.value); }} className="mt-1 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm" /></label><label className="mt-3 block text-xs font-semibold">說明<textarea value={description} maxLength={2000} onChange={(event) => { setDirty(true); setDescription(event.target.value); }} className="mt-1 min-h-24 w-full resize-y rounded-xl border border-stone-300 p-3 text-sm" /></label><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={busy} className="min-h-11 rounded-xl border border-emerald-800 text-sm font-semibold text-emerald-900" onClick={() => void saveDraft()}>儲存說明</button><button disabled={busy} className="min-h-11 rounded-xl bg-emerald-900 text-sm font-semibold text-white" onClick={() => void download()}>短效下載</button><button disabled={busy} className="min-h-11 rounded-xl border border-rose-700 text-sm font-semibold text-rose-800" onClick={() => void remove()}>移除附件</button></div></article>;
}

function ImageCard({ item, busy, download, preview, remove, save, setCover, retry, reload, isCover }: Readonly<{ item: MediaGalleryItem; busy: boolean; download(): Promise<void>; preview(): Promise<void>; remove(): Promise<void>; save(caption: string): Promise<boolean>; setCover(): Promise<boolean>; retry(): Promise<boolean>; reload(): Promise<boolean>; isCover: boolean }>) {
  const [caption, setCaption] = useState(item.asset.caption ?? "");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!dirty) setCaption(item.asset.caption ?? "");
  }, [dirty, item.asset.caption]);
  return <article className="overflow-hidden rounded-2xl border border-stone-200 bg-white"><Thumbnail item={item} onError={() => void reload()} /><div className="p-3"><p className="truncate text-sm font-semibold">{item.asset.caption || item.asset.originalFileName}</p>{item.asset.purpose === "gallery_image" && <label className="mt-2 block text-xs font-semibold">圖片說明<input aria-label="圖片說明" value={caption} maxLength={2000} onChange={(event) => { setDirty(true); setCaption(event.target.value); }} className="mt-1 min-h-10 w-full rounded-lg border border-stone-300 px-2 text-sm" /></label>}<div className="mt-3 grid gap-2">{item.asset.purpose === "gallery_image" && <button disabled={busy} className="min-h-10 rounded-xl border border-emerald-800 px-2 text-xs font-semibold text-emerald-900" onClick={() => void save(caption).then((saved) => { if (saved) setDirty(false); })}>儲存說明</button>}<button disabled={busy} className="min-h-10 rounded-xl border border-emerald-800 px-2 text-xs font-semibold text-emerald-900" onClick={() => void preview()}>預覽原檔</button><button disabled={busy} className="min-h-10 rounded-xl border border-emerald-800 px-2 text-xs font-semibold text-emerald-900" onClick={() => void download()}>下載原檔</button><button disabled={busy} className="min-h-10 rounded-xl bg-emerald-900 px-2 text-xs font-semibold text-white" onClick={() => void setCover()}>{isCover ? "目前自訂封面" : "設為封面"}</button><button disabled={busy} className="min-h-10 rounded-xl border border-rose-700 px-2 text-xs font-semibold text-rose-800" onClick={() => void remove()}>移除</button>{item.thumbnail?.state === "failed" ? <button disabled={busy} className="min-h-10 rounded-xl border border-rose-700 px-2 text-xs font-semibold text-rose-800" onClick={() => void retry()}>重試縮圖</button> : item.thumbnailError && <button disabled={busy} className="min-h-10 rounded-xl border border-amber-700 px-2 text-xs font-semibold text-amber-900" onClick={() => void reload()}>重新載入縮圖</button>}</div></div></article>;
}

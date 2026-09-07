"use client";

import { useEffect, useState } from "react";
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
const statusLabel: Record<MediaBatchFile["status"], string> = {
  queued: "等待中", uploading: "上傳中", processing: "確認原檔中", succeeded: "原檔已保存",
  failed: "上傳失敗", cancelled: "已暫停",
};

async function responseJson<T>(response: Response): Promise<T> {
  let body: T | JsonError;
  try { body = await response.json() as T; }
  catch { throw new Error("伺服器回應格式無效，請稍後重試。"); }
  if (!response.ok) throw new Error((body as JsonError).message ?? "媒體操作失敗，請重試。");
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

function Thumbnail({ item }: Readonly<{ item: MediaGalleryItem }>) {
  if (item.thumbnailUrl) return <div role="img" aria-label={item.asset.caption || item.asset.originalFileName} className="h-full min-h-36 w-full bg-emerald-800 bg-cover bg-center" style={{ backgroundImage: `url("${item.thumbnailUrl.replaceAll('"', "%22")}")` }} />;
  const failed = item.thumbnail?.state === "failed";
  return <div className={`flex min-h-36 flex-col items-center justify-center gap-2 px-4 text-center ${failed ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-900"}`}><span aria-hidden className="text-3xl">{failed ? "△" : "◌"}</span><span className="text-sm font-semibold">{failed ? "縮圖處理失敗" : "縮圖處理中"}</span><span className="text-xs">原檔已安全保存</span></div>;
}

export function MediaGalleryClient({ gameId }: Readonly<{ gameId: string }>) {
  const [gallery, setGallery] = useState<MediaGallery | null>(null);
  const [files, setFiles] = useState<readonly MediaBatchFile[]>([]);
  const [purpose, setPurpose] = useState<MediaPurpose>("gallery_image");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [batch] = useState(() => createMediaBatchUpload({
    identityStore: createSessionMediaIdentityStore(gameId),
    async upload({ idempotencyKey, file, purpose: filePurpose, onProgress, onProcessing }) {
      const beginResponse = await fetch("/api/private/media/uploads/begin", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey, gameId, purpose: filePurpose, originalFileName: file.name, declaredMimeType: file.type || "application/octet-stream", declaredByteSize: file.size }),
      });
      const begun = await responseJson<UploadGrant | { status: "finalizing" } | { status: "already_finalized"; result: { asset: { id: string }; thumbnail: { state: "pending" | "processing" | "ready" | "failed" } | null } }>(beginResponse);
      if (begun.status === "already_finalized") return { assetId: begun.result.asset.id, thumbnailState: begun.result.thumbnail?.state ?? null };
      if (begun.status === "finalizing") { onProcessing(); return finalize(idempotencyKey); }
      const transport = createBrowserMediaUpload({ grant: begun, file, onProgress: (uploaded) => onProgress(uploaded) });
      const result = await transport.completion;
      if (result.status !== "uploaded") throw new Error(result.status === "cancelled" ? "上傳已暫停，可稍後續傳。" : result.error.message);
      onProcessing();
      return finalize(idempotencyKey);
    },
  }));

  async function loadGallery() {
    const response = await fetch(`/api/private/media/games/${gameId}`, { cache: "no-store" });
    setGallery(await responseJson<MediaGallery>(response));
  }

  useEffect(() => {
    const unsubscribe = batch.subscribe(setFiles);
    void fetch(`/api/private/media/games/${gameId}`, { cache: "no-store" })
      .then((response) => responseJson<MediaGallery>(response))
      .then(setGallery, (error) => setMessage(error instanceof Error ? error.message : "相簿讀取失敗。"));
    const warnOnLeave = (event: BeforeUnloadEvent) => {
      if (batch.snapshot().some((item) => ["queued", "uploading", "processing"].includes(item.status))) event.preventDefault();
    };
    window.addEventListener("beforeunload", warnOnLeave);
    return () => { unsubscribe(); window.removeEventListener("beforeunload", warnOnLeave); };
  }, [batch, gameId]);

  async function chooseFiles(selected: FileList | null) {
    if (!selected?.length) return;
    const accepted = [...selected].filter((file) => {
      if (file.size > 0 && file.size <= MEDIA_MAX_BYTES) return true;
      setMessage(file.size === 0 ? `${file.name} 是空檔案。` : `${file.name} 超過 50 MB 上限。`);
      return false;
    });
    if (!accepted.length) return;
    batch.add(accepted, purpose);
    setMessage("批次已開始；離開頁面前請等候原檔保存完成。");
    await batch.start();
    await loadGallery();
  }

  async function action(run: () => Promise<void>, pending: string) {
    if (busy) return;
    setBusy(true); setMessage(pending);
    try { await run(); await loadGallery(); setMessage("已完成。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失敗，請重試。"); }
    finally { setBusy(false); }
  }

  async function post(path: string, body: unknown = {}) {
    await responseJson(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async function download(item: MediaGalleryItem) {
    await action(async () => {
      const read = await responseJson<{ url: string }>(await fetch(`/api/private/media/assets/${item.asset.id}/original`, { cache: "no-store" }));
      window.location.assign(read.url);
    }, "正在核發 60 秒下載網址……");
  }

  const failedCount = files.filter((file) => file.status === "failed").length;
  const images = gallery?.items.filter((item) => item.asset.purpose !== "attachment") ?? [];
  const attachments = gallery?.items.filter((item) => item.asset.purpose === "attachment") ?? [];

  return <section aria-labelledby="media-heading" className="mt-10 overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-[#fffdf6] shadow-[0_24px_60px_-42px_rgba(6,78,59,.65)]">
    <header className="border-b border-emerald-950/10 bg-[linear-gradient(135deg,#e8f3e9_0%,#fff7db_100%)] px-5 py-6">
      <p className="text-xs font-bold tracking-[.22em] text-emerald-800">PRIVATE MEDIA CABINET</p>
      <h2 id="media-heading" className="mt-2 text-2xl font-semibold text-emerald-950">照片與遊戲附件</h2>
      <p className="mt-2 max-w-prose text-sm leading-6 text-emerald-950/70">原檔保存在私人空間；相簿只載入縮圖，下載網址約 60 秒後失效。</p>
    </header>

    <div className="px-4 py-5 sm:px-6">
      <fieldset className="grid grid-cols-3 gap-2" disabled={files.some((file) => ["queued", "uploading", "processing"].includes(file.status))}>
        <legend className="mb-2 text-sm font-semibold">這批檔案要放在哪裡？</legend>
        {([['gallery_image', '相簿照片'], ['custom_cover', '自訂封面'], ['attachment', '遊戲附件']] as const).map(([value, label]) => <label key={value} className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-2 text-center text-sm font-semibold focus-within:ring-2 focus-within:ring-emerald-700 ${purpose === value ? "border-emerald-800 bg-emerald-900 text-white" : "border-emerald-950/15 bg-white text-emerald-950"}`}><input className="sr-only" type="radio" name="media-purpose" checked={purpose === value} onChange={() => setPurpose(value)} />{label}</label>)}
      </fieldset>
      <label className="mt-3 flex min-h-14 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-emerald-700 bg-emerald-50 px-4 text-center font-semibold text-emerald-950 hover:bg-emerald-100 focus-within:ring-2 focus-within:ring-emerald-700">
        <input className="sr-only" type="file" multiple accept={purpose === "attachment" ? undefined : "image/png,image/jpeg,image/gif,image/webp"} onChange={(event) => { void chooseFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
        選取多個檔案 <span className="ml-2 text-xs font-normal">每檔上限 50 MB</span>
      </label>

      {files.length > 0 && <div aria-label="批次上傳狀態" className="mt-4 space-y-2">{files.map((file) => <div key={file.idempotencyKey} className="rounded-xl border border-stone-200 bg-white p-3"><div className="flex items-start justify-between gap-3"><span className="min-w-0 truncate text-sm font-medium">{file.file.name}</span><span className={`shrink-0 text-xs font-bold ${file.status === "failed" ? "text-rose-700" : file.status === "succeeded" ? "text-emerald-700" : "text-amber-700"}`}>{statusLabel[file.status]}</span></div>{file.status === "uploading" && <progress aria-label={`${file.file.name} 上傳進度`} className="mt-2 h-2 w-full accent-emerald-700" max={file.file.size} value={file.uploadedBytes} />}{file.error && <p role="alert" className="mt-2 text-xs text-rose-700">{file.error}</p>}</div>)}</div>}
      {failedCount > 0 && <button className="mt-3 min-h-12 w-full rounded-xl bg-rose-700 px-4 font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void batch.retryFailed().then(loadGallery)}>只重試 {failedCount} 個失敗檔案</button>}
      {message && <p aria-live="polite" className="mt-3 rounded-xl bg-stone-100 px-3 py-2 text-sm text-stone-700">{message}</p>}
    </div>

    <div className="border-t border-emerald-950/10 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">相簿</h3><p className="text-xs text-stone-500">最新上傳排在前面</p></div>{gallery?.manualCoverAssetId && <button disabled={busy} className="min-h-11 rounded-xl border border-emerald-800 px-3 text-sm font-semibold text-emerald-900" onClick={() => void action(() => post(`/api/private/media/games/${gameId}/cover`, { mode: "source" }), "正在恢復來源封面……")}>恢復來源封面</button>}</div>
      {images.length === 0 ? <p className="mt-4 rounded-2xl bg-stone-100 px-4 py-8 text-center text-sm text-stone-600">還沒有相簿照片。一次選取多張，系統會逐檔保存。</p> : <div className="mt-4 grid grid-cols-2 gap-3">{images.map((item) => <article key={item.asset.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white"><Thumbnail item={item} /><div className="p-3"><p className="truncate text-sm font-semibold">{item.asset.caption || item.asset.originalFileName}</p><div className="mt-3 grid gap-2"><button disabled={busy} className="min-h-11 rounded-xl bg-emerald-900 px-2 text-xs font-semibold text-white" onClick={() => void action(() => post(`/api/private/media/games/${gameId}/cover`, { mode: "manual", assetId: item.asset.id }), "正在更換封面……")}>{gallery?.manualCoverAssetId === item.asset.id ? "目前自訂封面" : "設為封面"}</button>{item.thumbnail?.state === "failed" && <button disabled={busy} className="min-h-11 rounded-xl border border-rose-700 px-2 text-xs font-semibold text-rose-800" onClick={() => void action(() => post(`/api/private/media/assets/${item.asset.id}/retry-thumbnail`), "正在重試縮圖……")}>重試縮圖</button>}</div></div></article>)}</div>}
      {gallery?.sourceCover && <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-3"><p className="mb-2 text-sm font-semibold">來源封面</p><div className="h-28 overflow-hidden rounded-xl"><Thumbnail item={gallery.sourceCover} /></div></div>}
    </div>

    <div className="border-t border-emerald-950/10 px-4 py-6 sm:px-6"><h3 className="text-lg font-semibold">遊戲附件</h3>{attachments.length === 0 ? <p className="mt-3 text-sm text-stone-600">尚未加入規則書或玩家輔助檔案。</p> : <div className="mt-3 space-y-3">{attachments.map((item) => <AttachmentCard key={item.asset.id} item={item} busy={busy} save={(body) => action(() => post(`/api/private/media/assets/${item.asset.id}/metadata`, body), "正在儲存附件說明……")} download={() => download(item)} />)}</div>}</div>
  </section>;
}

function AttachmentCard({ item, busy, save, download }: Readonly<{ item: MediaGalleryItem; busy: boolean; save(body: unknown): Promise<void>; download(): Promise<void> }>) {
  const [displayName, setDisplayName] = useState(item.asset.displayName ?? "");
  const [description, setDescription] = useState(item.asset.description ?? "");
  return <article className="rounded-2xl border border-stone-200 bg-white p-4"><p className="truncate text-sm font-semibold">{item.asset.displayName || item.asset.originalFileName}</p><p className="mt-1 text-xs text-stone-500">{item.asset.originalFileName}</p><label className="mt-3 block text-xs font-semibold">顯示名稱<input value={displayName} maxLength={255} onChange={(event) => setDisplayName(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm" /></label><label className="mt-3 block text-xs font-semibold">說明<textarea value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} className="mt-1 min-h-24 w-full resize-y rounded-xl border border-stone-300 p-3 text-sm" /></label><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={busy} className="min-h-11 rounded-xl border border-emerald-800 text-sm font-semibold text-emerald-900" onClick={() => void save({ displayName, description })}>儲存說明</button><button disabled={busy} className="min-h-11 rounded-xl bg-emerald-900 text-sm font-semibold text-white" onClick={() => void download()}>短效下載</button></div></article>;
}

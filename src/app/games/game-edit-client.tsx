"use client";

import { useState } from "react";
import Link from "next/link";
import type { GameRecord } from "@/modules/games";
import { addManualContribution, deletePlatform, deleteTag, editGame, linkExternalSource, refreshExternalMetadata, removeManualContribution } from "@/app/private-mutation-actions";
import type { PrivateActionResult } from "@/shared/auth/private-action";

type Props = Readonly<{ game: GameRecord }>;
const systemPlatforms = new Set(["steam", "ps5", "xbox series", "nintendo switch"]);
const roleLabels = { design: "設計／開發", art: "美術", publisher: "發行" } as const;

class PrivateActionError extends Error {
  constructor(readonly result: Extract<PrivateActionResult, { ok: false }>) { super(result.message); this.name = "PrivateActionError"; }
}

function unwrapPrivateAction<Success extends object>(result: PrivateActionResult<Success>): Success {
  if (!result.ok) throw new PrivateActionError(result);
  return result;
}

export function GameEditClient({ game }: Props) {
  const [message, setMessage] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; releaseYear: number | null } | null>(null);
  const [linkReady, setLinkReady] = useState(false);
  const [conflictGameId, setConflictGameId] = useState<string | null>(null);
  const provider = game.medium === "board_game" ? "bgg" : "igdb";
  const manualContributions = game.contributors.filter((item) => item.origin === "manual");
  const sourceContributions = game.contributors.filter((item) => item.origin === "source");
  const platformOptions = [...new Set(["Steam", "PS5", "Xbox Series", "Nintendo Switch", ...game.actualPlatforms])];
  const customPlatforms = game.actualPlatforms.filter((platform) => !systemPlatforms.has(platform.toLocaleLowerCase("en-US")));

  async function deleteShared(action: typeof deletePlatform | typeof deleteTag, name: string) {
    try {
      setMessage("刪除中……");
      unwrapPrivateAction(await action({ name }));
      window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "刪除失敗，請重試。"); }
  }

  async function edit(form: FormData) {
    try {
      setMessage("儲存中……");
      unwrapPrivateAction(await editGame({
        gameId: game.id,
        displayName: form.get("displayName"),
        actualPlatforms: [...form.getAll("actualPlatforms").filter((value): value is string => typeof value === "string"), ...String(form.get("customPlatform") ?? "").split(",")],
        tags: String(form.get("tags") ?? "").split(","),
        playerCountNote: form.get("playerCountNote"),
      }));
      window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "儲存失敗，請重試。"); }
  }

  async function addContribution(form: FormData) {
    try {
      setMessage("儲存中……");
      const result = unwrapPrivateAction(await addManualContribution({ gameId: game.id, name: form.get("name"), entityKind: form.get("entityKind"), role: form.get("role") }));
      if (result.possibleDuplicate) {
        setMessage("已新增；名稱可能與既有貢獻者重複，未自動合併。頁面即將更新。");
        window.setTimeout(() => window.location.reload(), 1200);
      } else {
        window.location.reload();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "新增失敗，請重試。"); }
  }

  async function removeManual(id: string) {
    try {
      setMessage("移除中……");
      unwrapPrivateAction(await removeManualContribution({ gameId: game.id, contributionId: id }));
      window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "移除失敗，請重試。"); }
  }

  async function refresh() {
    try { setMessage("重新整理中……"); unwrapPrivateAction(await refreshExternalMetadata({ gameId: game.id })); window.location.reload(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "重新整理失敗，舊資料仍可使用。"); }
  }

  async function confirmSource() {
    try {
      const response = await fetch("/api/private/games/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, sourceId }) });
      const body = await response.json() as { fingerprint?: string; message?: string; candidate?: { title?: string; releaseYear?: number | null } };
      if (!response.ok || !body.fingerprint) throw new Error(body.message ?? "無法取得來源資料。");
      setFingerprint(body.fingerprint);
      setConfirmation(body.candidate?.title ? { title: body.candidate.title, releaseYear: body.candidate.releaseYear ?? null } : null);
      setLinkReady(true);
      setMessage("來源已取得，請再次確認後連結。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "無法取得來源資料。"); }
  }

  async function link() {
    try {
      setConflictGameId(null);
      setMessage("連結中……");
      unwrapPrivateAction(await linkExternalSource({ gameId: game.id, provider, sourceId, confirmationFingerprint: fingerprint }));
      window.location.reload();
    } catch (error) {
      if (error instanceof PrivateActionError && typeof error.result.existingGameId === "string") setConflictGameId(error.result.existingGameId);
      setMessage(error instanceof Error ? error.message : "連結失敗，原條目未變更。");
    }
  }

  return <section className="mt-8 space-y-6 rounded-2xl border border-slate-200 bg-white p-4">
    <p role="status" className="text-sm text-slate-600">{message}</p>
    <details>
      <summary className="cursor-pointer font-semibold">編輯擁有者資料</summary>
      <form action={edit} className="mt-4 space-y-3">
        <label className="block text-sm">自訂顯示名稱<input name="displayName" defaultValue={game.customDisplayName ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3" placeholder="留白則使用來源名稱" /></label>
        {game.medium === "video_game" && <fieldset><legend className="text-sm">實際平台</legend><div className="mt-2 flex flex-wrap gap-3">{platformOptions.map((platform) => <label className="flex items-center gap-2 text-sm" key={platform}><input type="checkbox" name="actualPlatforms" value={platform} defaultChecked={game.actualPlatforms.some((value) => value.toLocaleLowerCase() === platform.toLocaleLowerCase())} />{platform}</label>)}</div>{customPlatforms.length > 0 && <div className="mt-2 flex flex-wrap gap-2 text-xs">{customPlatforms.map((platform) => <button type="button" className="rounded-full border border-rose-200 px-3 py-1 text-rose-700" key={platform} onClick={() => void deleteShared(deletePlatform, platform)}>刪除平台：{platform}</button>)}</div>}<input name="customPlatform" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" placeholder="新增自訂平台（以逗號分隔）" /></fieldset>}
        <label className="block text-sm">自由標籤（以逗號分隔）<input name="tags" defaultValue={game.tags.join(", ")} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3" /></label>
        {game.tags.length > 0 && <div className="flex flex-wrap gap-2 text-xs">{game.tags.map((tag) => <button type="button" className="rounded-full border border-rose-200 px-3 py-1 text-rose-700" key={tag} onClick={() => void deleteShared(deleteTag, tag)}>刪除標籤：{tag}</button>)}</div>}
        <label className="block text-sm">人數說明（選填）<textarea name="playerCountNote" defaultValue={game.playerCountNote ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3" rows={3} /></label>
        <button className="w-full rounded-xl bg-emerald-900 px-4 py-3 font-semibold text-white" type="submit">儲存資料</button>
      </form>
    </details>
    <details>
      <summary className="cursor-pointer font-semibold">貢獻關係</summary>
      <div className="mt-4 space-y-4">
        <div><h3 className="text-sm font-medium">來源貢獻（唯讀）</h3>{sourceContributions.length === 0 ? <p className="mt-1 text-sm text-slate-500">沒有來源貢獻。</p> : <ul className="mt-1 space-y-1 text-sm">{sourceContributions.map((item) => <li key={`${item.id}:${item.role}`}>{item.name} · {roleLabels[item.role]} · {item.provider?.toUpperCase()}</li>)}</ul>}</div>
        <div><h3 className="text-sm font-medium">手動貢獻</h3>{manualContributions.length > 0 && <ul className="mt-1 space-y-1 text-sm">{manualContributions.map((item) => <li className="flex items-center justify-between gap-2" key={item.id}><span>{item.name} · {roleLabels[item.role]}</span><button type="button" className="text-sm text-rose-700" onClick={() => void removeManual(item.id)}>移除</button></li>)}</ul>}<form action={addContribution} className="mt-3 space-y-2"><input name="name" className="w-full rounded-xl border border-slate-300 px-3 py-3" placeholder="人物或組織名稱" required /><div className="flex gap-2"><select name="entityKind" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-3"><option value="person">人物</option><option value="company">組織</option></select><select name="role" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-3"><option value="design">設計／開發</option><option value="art">美術</option><option value="publisher">發行</option></select></div><button className="w-full rounded-xl border border-emerald-900 px-4 py-3 font-semibold text-emerald-900" type="submit">新增手動貢獻</button></form></div>
      </div>
    </details>
    {game.snapshot ? <button type="button" onClick={() => void refresh()} className="w-full rounded-xl border border-slate-300 px-4 py-3 font-semibold">重新整理來源資料</button> : <details><summary className="cursor-pointer font-semibold">首次連結外部來源</summary><div className="mt-4 space-y-3"><div className="flex gap-2"><span className="rounded-xl border border-slate-300 px-3 py-3 text-sm">{provider.toUpperCase()}</span><input value={sourceId} onChange={(event) => { setSourceId(event.target.value); setLinkReady(false); setConfirmation(null); setConflictGameId(null); }} className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-3" placeholder="來源 ID" inputMode="numeric" /></div><button type="button" onClick={() => void confirmSource()} className="w-full rounded-xl border border-slate-300 px-4 py-3">取得並確認來源</button>{confirmation && <div className="rounded-xl bg-emerald-50 p-3 text-sm"><p className="font-semibold">{confirmation.title}</p>{confirmation.releaseYear && <p className="mt-1 text-slate-600">{confirmation.releaseYear}</p>}<p className="mt-1 text-slate-600">請確認這是要連結的遊戲。</p></div>}{conflictGameId && <Link href={`/games/${conflictGameId}`} className="block rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-900">開啟既有條目</Link>}{linkReady && <button type="button" onClick={() => void link()} className="w-full rounded-xl bg-emerald-900 px-4 py-3 font-semibold text-white">連結此來源</button>}</div></details>}
  </section>;
}

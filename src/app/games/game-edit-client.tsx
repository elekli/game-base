"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { ExternalGameRef, GameRecord, NormalizedSearchCandidate, Provider } from "@/modules/games";
import { addManualContribution, deletePlatform, deleteTag, editGame, linkExternalSource, refreshExternalMetadata, removeManualContribution } from "@/app/private-mutation-actions";
import type { PrivateActionResult } from "@/shared/auth/private-action";

type Props = Readonly<{ game: GameRecord }>;
type SearchGroup = Readonly<{ provider: Provider; items: readonly NormalizedSearchCandidate[]; errorCode: string | null }>;
type SearchResponse = Readonly<{ groups?: readonly SearchGroup[]; message?: string }>;
type ConfirmationResponse = Readonly<{ candidate?: NormalizedSearchCandidate; fingerprint?: string; message?: string }>;
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
  const [linkQuery, setLinkQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly NormalizedSearchCandidate[]>([]);
  const [searchSourceError, setSearchSourceError] = useState("");
  const [searchProvider, setSearchProvider] = useState<Provider | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedRef, setSelectedRef] = useState<ExternalGameRef | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [confirmation, setConfirmation] = useState<NormalizedSearchCandidate | null>(null);
  const [linkReady, setLinkReady] = useState(false);
  const [conflictGameId, setConflictGameId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [confirmingRefKey, setConfirmingRefKey] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const requestVersion = useRef(0);
  const linkingRef = useRef(false);
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

  function clearLinkState() {
    setSelectedRef(null);
    setFingerprint("");
    setConfirmation(null);
    setLinkReady(false);
    setConflictGameId(null);
    setConfirmingRefKey(null);
  }

  function handleSearchQueryChange(value: string) {
    requestVersion.current += 1;
    setLinkQuery(value);
    setCandidates([]);
    setSearchProvider(null);
    setSearchSourceError("");
    setHasSearched(false);
    setIsSearching(false);
    clearLinkState();
    setMessage("");
  }

  function searchErrorMessage(errorCode: string) {
    const messages: Record<string, string> = {
      source_query_invalid: "搜尋條件無效，請輸入遊戲名稱。",
      source_rate_limited: "來源目前忙碌，請稍後再搜尋。",
      source_unavailable: "來源暫時無法使用，請稍後再搜尋。",
      source_authentication_failed: "來源驗證設定無效，請稍後再試。",
      source_authentication_unavailable: "來源驗證服務暫時無法使用，請稍後再試。",
      source_response_invalid: "來源回應無法安全使用，請稍後再試。",
    };
    return messages[errorCode] ?? "來源搜尋失敗，請稍後再試。";
  }

  async function searchSources() {
    const version = ++requestVersion.current;
    const query = linkQuery.trim();
    clearLinkState();
    setCandidates([]);
    setSearchProvider(null);
    setSearchSourceError("");
    if (!query) {
      setHasSearched(false);
      setIsSearching(false);
      setSearchSourceError("請輸入遊戲名稱後再搜尋。");
      setMessage("");
      return;
    }
    setHasSearched(true);
    setIsSearching(true);
    setMessage("搜尋中……");
    try {
      const params = new URLSearchParams({ q: query, medium: game.medium });
      const response = await fetch(`/api/private/games/search?${params.toString()}`);
      let body: SearchResponse;
      try {
        body = await response.json() as SearchResponse;
      } catch {
        throw new Error("搜尋回應格式無效，請稍後再試。");
      }
      if (version !== requestVersion.current) return;
      if (!response.ok) throw new Error(body.message ?? "搜尋服務暫時無法使用，請稍後再試。");
      const group = body.groups?.[0];
      if (!group) throw new Error("搜尋回應格式無效，請稍後再試。");
      setSearchProvider(group.provider);
      setCandidates(group.items);
      if (group.errorCode) {
        setSearchSourceError(searchErrorMessage(group.errorCode));
        setMessage("");
      } else if (group.items.length === 0) {
        setMessage("沒有找到結果，請改用其他遊戲名稱搜尋。");
      } else {
        setMessage("");
      }
    } catch (error) {
      if (version !== requestVersion.current) return;
      setSearchSourceError(error instanceof Error ? error.message : "搜尋失敗，請稍後再試。");
      setMessage("");
    } finally {
      if (version === requestVersion.current) setIsSearching(false);
    }
  }

  async function confirmSource(ref: ExternalGameRef) {
    const version = ++requestVersion.current;
    const refKey = `${ref.provider}:${ref.sourceId}`;
    clearLinkState();
    setSelectedRef(ref);
    setConfirmingRefKey(refKey);
    setSearchSourceError("");
    setMessage("取得來源確認中……");
    try {
      const response = await fetch("/api/private/games/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ref) });
      let body: ConfirmationResponse;
      try {
        body = await response.json() as ConfirmationResponse;
      } catch {
        throw new Error("來源確認回應格式無效，請稍後再試。");
      }
      if (version !== requestVersion.current) return;
      if (!response.ok || !body.fingerprint || !body.candidate) throw new Error(body.message ?? "來源確認失敗，請稍後再試。");
      setFingerprint(body.fingerprint);
      setConfirmation(body.candidate);
      setLinkReady(true);
      setMessage("來源已取得，請確認資料後連結。");
    } catch (error) {
      if (version !== requestVersion.current) return;
      setSelectedRef(null);
      setFingerprint("");
      setConfirmation(null);
      setLinkReady(false);
      setMessage(error instanceof Error ? error.message : "來源確認失敗，請稍後再試。");
    } finally {
      if (version === requestVersion.current) setConfirmingRefKey(null);
    }
  }

  async function link() {
    if (!selectedRef || !fingerprint) {
      setMessage("請先取得並確認來源。");
      return;
    }
    if (linkingRef.current) return;
    try {
      linkingRef.current = true;
      setIsLinking(true);
      setConflictGameId(null);
      setMessage("連結中……");
      unwrapPrivateAction(await linkExternalSource({ gameId: game.id, provider: selectedRef.provider, sourceId: selectedRef.sourceId, confirmationFingerprint: fingerprint }));
      window.location.reload();
    } catch (error) {
      if (error instanceof PrivateActionError) {
        if (typeof error.result.existingGameId === "string") setConflictGameId(error.result.existingGameId);
        setMessage(error.result.existingIsTrashed
          ? "此來源已存在於資源回收區，請先還原，再開啟既有條目。"
          : error.result.message);
      } else {
        setMessage(error instanceof Error ? error.message : "連結失敗，原條目未變更。");
      }
    } finally {
      linkingRef.current = false;
      setIsLinking(false);
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
    {game.snapshot ? <button type="button" onClick={() => void refresh()} className="w-full rounded-xl border border-slate-300 px-4 py-3 font-semibold">重新整理來源資料</button> : <details>
      <summary className="cursor-pointer font-semibold">首次連結外部來源</summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-slate-600">同媒介來源：{game.medium === "board_game" ? "BGG 桌遊" : "IGDB 電子遊戲"}</p>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void searchSources(); }}>
          <label className="block text-sm">名稱搜尋<input value={linkQuery} onChange={(event) => handleSearchQueryChange(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3" placeholder="輸入遊戲名稱" /></label>
          <button type="submit" disabled={isSearching || isLinking} className="w-full rounded-xl border border-slate-300 px-4 py-3 font-semibold disabled:opacity-60">{isSearching ? "搜尋中……" : "搜尋來源"}</button>
        </form>
        {searchSourceError && <p role="alert" className="text-sm text-rose-700">{searchSourceError}</p>}
        {hasSearched && !searchSourceError && candidates.length === 0 && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">沒有找到結果，請改用其他遊戲名稱搜尋。</p>}
        {hasSearched && searchProvider && candidates.length > 0 && <section aria-live="polite" className="space-y-2">
          <h3 className="text-sm font-semibold">{searchProvider === "bgg" ? "BGG 桌遊" : "IGDB 電子遊戲"}</h3>
          <ul className="space-y-2">
            {candidates.map((candidate) => {
              const refKey = `${candidate.ref.provider}:${candidate.ref.sourceId}`;
              const isSelected = selectedRef !== null && selectedRef.provider === candidate.ref.provider && selectedRef.sourceId === candidate.ref.sourceId;
              return <li key={refKey} className={`rounded-xl border bg-white p-4 ${isSelected ? "border-emerald-700" : "border-slate-200"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{candidate.title}</p>
                    <p className="mt-1 text-sm text-slate-600">發行年份：{candidate.releaseYear ?? "未提供"}</p>
                    <p className="mt-1 text-sm text-slate-600">來源：{candidate.ref.provider.toUpperCase()}</p>
                  </div>
                  <button type="button" disabled={isSearching || isLinking || confirmingRefKey !== null} onClick={() => void confirmSource(candidate.ref)} className="shrink-0 rounded-xl bg-slate-100 px-3 py-3 text-sm font-semibold disabled:opacity-60">{confirmingRefKey === refKey ? "確認中……" : "取得並確認"}</button>
                </div>
              </li>;
            })}
          </ul>
        </section>}
        {confirmation && selectedRef && <div className="rounded-xl bg-emerald-50 p-3 text-sm"><p className="font-semibold">{confirmation.title}</p><p className="mt-1 text-slate-600">發行年份：{confirmation.releaseYear ?? "未提供"}</p><p className="mt-1 text-slate-600">來源：{confirmation.ref.provider.toUpperCase()}</p><p className="mt-1 text-slate-600">請確認這是要連結的遊戲。</p></div>}
        {conflictGameId && <Link href={`/games/${conflictGameId}`} className="block rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-900">開啟既有條目</Link>}
        {linkReady && <button type="button" disabled={isLinking || confirmingRefKey !== null} onClick={() => void link()} className="w-full rounded-xl bg-emerald-900 px-4 py-3 font-semibold text-white disabled:opacity-60">{isLinking ? "連結中……" : "連結此來源"}</button>}
      </div>
    </details>}
  </section>;
}

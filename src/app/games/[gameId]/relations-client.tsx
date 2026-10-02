"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import type { NormalizedSearchCandidate } from "@/modules/games";
import type { GameRelation, RelationTarget } from "@/modules/relations";
import { addGameRelation, describeGameRelation, removeGameRelation, restoreGameRelation, searchRelationTargets } from "@/app/private-relation-actions";
import { retryExternalListThumbnail } from "@/app/private-list-actions";
import { GameLifecycleClient } from "@/app/games/game-lifecycle-client";

type LibraryOption = Readonly<{ id: string; displayName: string; version: number; trashed: boolean }>;
type UndoRelation = Readonly<{ id: string; version: number }>;

function isFailure<T extends { ok: boolean }>(value: T): value is Extract<T, { ok: false }> {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok?: unknown }).ok === false;
}

export function RelationsClient({ gameId, initialRelations, libraryGames }: Readonly<{ gameId: string; initialRelations: readonly GameRelation[]; libraryGames: readonly LibraryOption[] }>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedGameId, setSelectedGameId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly NormalizedSearchCandidate[]>([]);
  const [message, setMessage] = useState("");
  const [undo, setUndo] = useState<UndoRelation | null>(null);
  const [conflict, setConflict] = useState<UndoRelation | null>(null);
  const names = useMemo(() => new Map(libraryGames.map((game) => [game.id, game.displayName])), [libraryGames]);

  const add = (target: RelationTarget) => startTransition(async () => {
    setMessage(""); setUndo(null); setConflict(null);
    const result = await addGameRelation({ commandId: crypto.randomUUID(), left: { kind: "game", gameId }, right: target });
    if (isFailure(result)) {
      setMessage(result.message);
      if (result.restorableRelation && result.existingRelationId && result.existingRelationVersion) setConflict({ id: result.existingRelationId, version: result.existingRelationVersion });
      return;
    }
    setSelectedGameId(""); setResults([]); router.refresh();
  });

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      setMessage(""); setResults([]);
      const result = await searchRelationTargets({ query });
      if (isFailure(result)) { setMessage(result.message); return; }
      const groups = result.groups ?? [];
      setResults(groups.flatMap((group) => group.items));
      const hasUnavailableSource = groups.some((group) => group.errorCode !== null);
      if (groups.every((group) => group.items.length === 0)) setMessage(hasUnavailableSource ? "來源暫時無法搜尋，請稍後重試。" : "沒有找到來源遊戲。");
      else if (hasUnavailableSource) setMessage("部分來源暫時無法搜尋；仍顯示可用結果。");
    });
  };

  const remove = (relation: GameRelation) => startTransition(async () => {
    setMessage("");
    const result = await removeGameRelation({ commandId: crypto.randomUUID(), relationId: relation.id, expectedVersion: relation.version });
    if (isFailure(result)) { setMessage(result.message); return; }
    setUndo({ id: relation.id, version: result.version }); router.refresh();
  });

  const restore = (item: UndoRelation) => startTransition(async () => {
    setMessage("");
    const result = await restoreGameRelation({ commandId: crypto.randomUUID(), relationId: item.id, expectedVersion: item.version });
    if (isFailure(result)) { setMessage(result.message); return; }
    setUndo(null); setConflict(null); router.refresh();
  });

  const describe = (relation: GameRelation, event: FormEvent<HTMLFormElement>, trashed: boolean) => {
    event.preventDefault();
    if (trashed) return;
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      setMessage("");
      const value = String(form.get("description") ?? "").trim() || null;
      const result = await describeGameRelation({ commandId: crypto.randomUUID(), relationId: relation.id, expectedVersion: relation.version, description: value });
      if (isFailure(result)) { setMessage(result.message); return; }
      router.refresh();
    });
  };

  const retryThumbnail = (target: Extract<RelationTarget, { kind: "external" }>) => startTransition(async () => {
    setMessage("");
    const result = await retryExternalListThumbnail({ ref: target.ref });
    if (isFailure(result)) { setMessage(result.message); return; }
    router.refresh();
  });

  return <section id="relations-heading" aria-labelledby="relations-title" className="mt-8 rounded-2xl bg-white p-5">
    <h2 id="relations-title" className="text-xl font-semibold">關聯遊戲</h2>
    <p className="mt-1 text-sm text-slate-600">從任一款遊戲新增或解除，兩邊會同步顯示。</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">收藏庫遊戲
        <select value={selectedGameId} onChange={(event) => setSelectedGameId(event.target.value)} className="min-h-11 rounded-xl border border-slate-300 px-3" disabled={pending}>
          <option value="">選擇遊戲</option>{libraryGames.filter((game) => game.id !== gameId && !game.trashed).map((game) => <option key={game.id} value={game.id}>{game.displayName}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => selectedGameId && add({ kind: "game", gameId: selectedGameId })} disabled={!selectedGameId || pending} className="min-h-11 self-end rounded-xl bg-emerald-900 px-4 font-semibold text-white disabled:opacity-50">新增關聯</button>
    </div>
    <form onSubmit={search} className="mt-4 flex gap-2">
      <label className="sr-only" htmlFor="relation-search">搜尋庫外遊戲</label>
      <input id="relation-search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120} placeholder="搜尋 BGG 或 IGDB 遊戲" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3" />
      <button type="submit" disabled={pending || query.trim().length === 0} className="min-h-11 rounded-xl border border-emerald-900 px-4 font-semibold text-emerald-900 disabled:opacity-50">搜尋</button>
    </form>
    {results.length > 0 && <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200">{results.map((result) => <li key={`${result.ref.provider}:${result.ref.sourceId}`} className="flex items-center justify-between gap-3 p-3"><span className="min-w-0"><span className="block truncate font-medium">{result.title}</span><span className="text-sm text-slate-600">{result.ref.provider.toUpperCase()}・{result.releaseYear ?? "年份未知"}</span></span><button type="button" disabled={pending} onClick={() => add({ kind: "external", ref: result.ref, name: result.title, releaseYear: result.releaseYear })} className="min-h-10 shrink-0 rounded-xl border border-emerald-900 px-3 text-sm font-semibold text-emerald-900">新增</button></li>)}</ul>}
    {message && <p role="status" className="mt-3 text-sm text-rose-800">{message}</p>}
    {conflict && <button type="button" disabled={pending} onClick={() => restore(conflict)} className="mt-2 min-h-10 rounded-xl border border-emerald-900 px-3 text-sm font-semibold text-emerald-900">還原既有關聯</button>}
    {undo && <div className="mt-3 flex items-center gap-3 rounded-xl bg-emerald-50 p-3"><p role="status" className="text-sm">已解除關聯。</p><button type="button" disabled={pending} onClick={() => restore(undo)} className="min-h-10 rounded-xl border border-emerald-900 px-3 text-sm font-semibold text-emerald-900">立即復原</button></div>}
    {initialRelations.length === 0 ? <p className="mt-4 text-sm text-slate-600">尚無關聯遊戲。</p> : <ul className="mt-4 divide-y divide-slate-200">{initialRelations.map((relation) => {
      const otherIsLeft = relation.leftGameId === gameId;
      const other = otherIsLeft ? relation.right : relation.left;
      const otherGameId = otherIsLeft ? relation.rightGameId : relation.leftGameId;
      const otherGame = otherGameId ? libraryGames.find((game) => game.id === otherGameId) : undefined;
      const trashed = (otherIsLeft ? relation.rightTrashed : relation.leftTrashed) || (otherGame?.trashed ?? false);
      const title = otherGameId ? names.get(otherGameId) ?? "收藏庫遊戲" : other.kind === "external" ? other.name : "收藏庫遊戲";
      return <li key={relation.id} className={`py-3 ${trashed ? "grayscale" : ""}`}><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3">{other.kind === "external" && other.thumbnailUrl && <Image unoptimized src={other.thumbnailUrl} alt="" width={48} height={64} className="h-16 w-12 shrink-0 rounded object-cover" />}{other.kind === "external" && !other.thumbnailUrl && <div aria-hidden="true" className="h-16 w-12 shrink-0 rounded bg-slate-100" /> }<div><p className={`font-medium ${trashed ? "text-slate-500" : "text-slate-900"}`}>{title}{trashed && <span className="ml-2 text-xs">已移入資源回收區</span>}</p>{other.kind === "external" && <><p className="text-sm text-slate-600">{other.ref.provider.toUpperCase()}・{other.releaseYear ?? "年份未知"}・庫外引用</p>{other.thumbnailState === "pending" && <p className="text-xs text-slate-600">封面縮圖處理中；若稍後仍未完成，可重新檢查。</p>}{other.thumbnailState === "missing" && <p className="text-xs text-slate-600">封面縮圖尚未保存；可重新檢查。</p>}{(other.thumbnailState === "failed" || other.thumbnailState === "pending" || other.thumbnailState === "missing") && <button type="button" disabled={pending} onClick={() => retryThumbnail(other)} className="mt-1 text-sm text-emerald-900 underline">{other.thumbnailState === "pending" ? "重新檢查封面縮圖" : other.thumbnailState === "missing" ? "檢查封面縮圖" : "重試封面縮圖"}</button>}</>}</div></div>{trashed && otherGameId && otherGame ? <GameLifecycleClient gameId={otherGameId} version={otherGame.version} state="trashed" compact /> : <button type="button" disabled={pending} onClick={() => remove(relation)} className="min-h-10 shrink-0 rounded-xl border border-slate-300 px-3 text-sm">解除</button>}</div><form onSubmit={(event) => describe(relation, event, trashed)} className="mt-2 flex gap-2"><label className="sr-only" htmlFor={`relation-note-${relation.id}`}>關聯說明</label><input id={`relation-note-${relation.id}`} name="description" defaultValue={relation.description ?? ""} disabled={pending || trashed} maxLength={1000} placeholder="選填關聯說明" className="min-h-10 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-sm" /><button type="submit" disabled={pending || trashed} className="min-h-10 shrink-0 rounded-xl border border-slate-300 px-3 text-sm disabled:opacity-50">儲存</button></form></li>;
    })}</ul>}
  </section>;
}

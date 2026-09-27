"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createList, restoreList } from "@/app/private-list-actions";
import type { NormalizedSearchCandidate } from "@/modules/games/internal/types";
import { createListIntentKey, shouldRetainListCommand, type ListRecord, type ListTarget } from "@/modules/lists";

type SearchResponse = { groups: readonly { items: readonly NormalizedSearchCandidate[]; errorCode: string | null }[] };

export function NewListClient({ games }: { games: readonly { id: string; name: string; trashed: boolean }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [archived, setArchived] = useState<ListRecord | null>(null);
  const createCommand = useRef<{ targetKey: string; id: string } | null>(null);
  const restoreCommand = useRef<{ targetKey: string; id: string } | null>(null);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!name.trim() && !query.trim()) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [name, query]);
  async function search() {
    if (!query.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/private/games/search?q=${encodeURIComponent(query.trim())}`);
      if (!response.ok) throw new Error("source_search_failed");
      setResults(await response.json() as SearchResponse);
    } catch { setMessage("來源搜尋失敗，請稍後重試。"); }
    finally { setBusy(false); }
  }
  async function create(firstMember: ListTarget) {
    if (busy) return;
    setBusy(true); setMessage(""); setArchived(null);
    try {
      const targetKey = createListIntentKey(name, firstMember);
      if (createCommand.current?.targetKey !== targetKey) createCommand.current = { targetKey, id: crypto.randomUUID() };
      const response = await createList({ commandId: createCommand.current.id, name, firstMember });
      if (response.ok) { router.push(`/lists/${response.resourceId}`); return; }
      if (!shouldRetainListCommand(response.code)) createCommand.current = null;
      setMessage(response.message);
      if (response.code === "archived_list_found") setArchived(response.existingList ?? null);
    } catch { setMessage("無法確認清單是否已建立，請重試相同操作。"); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!archived || busy) return;
    setBusy(true);
    try {
      const targetKey = `${archived.id}:${archived.version}`;
      if (restoreCommand.current?.targetKey !== targetKey) restoreCommand.current = { targetKey, id: crypto.randomUUID() };
      const result = await restoreList({ commandId: restoreCommand.current.id, listId: archived.id, expectedVersion: archived.version });
      if (result.ok) { restoreCommand.current = null; router.push(`/lists/${archived.id}`); return; }
      if (!shouldRetainListCommand(result.code)) restoreCommand.current = null;
      setMessage(result.message);
    } catch { setMessage("還原失敗，請稍後重試。"); }
    finally { setBusy(false); }
  }
  const activeGames = games.filter((game) => !game.trashed);
  return <section className="mt-8 space-y-6"><label className="block font-semibold">清單名稱<input value={name} onChange={(event) => { setName(event.target.value); setArchived(null); }} maxLength={120} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3" placeholder="例如：想玩的策略遊戲" /></label><p role="status" className="text-sm text-amber-800">{message}</p>{archived && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4"><p className="font-semibold">已封存：{archived.name}</p><p className="mt-1 text-sm">{archived.memberCount} 款遊戲。還原會保留原有成員。</p><button type="button" disabled={busy} onClick={() => void restore()} className="mt-3 rounded-full bg-emerald-900 px-4 py-2 text-white">還原清單</button></div>}<div><h2 className="text-xl font-semibold">從收藏庫選取第一款</h2><ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">{activeGames.map((game) => <li key={game.id}><button type="button" disabled={busy || !name.trim()} onClick={() => void create({ kind: "game", gameId: game.id })} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left disabled:opacity-50">{game.name}</button></li>)}</ul>{activeGames.length === 0 && <p className="mt-2 text-sm text-slate-600">收藏庫目前沒有遊戲。</p>}</div><div><h2 className="text-xl font-semibold">或搜尋庫外遊戲</h2><div className="mt-3 flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3" placeholder="搜尋 BGG／IGDB" /><button type="button" disabled={busy || !query.trim()} onClick={() => void search()} className="rounded-xl bg-emerald-900 px-4 py-3 text-white disabled:opacity-50">搜尋</button></div><ul className="mt-3 space-y-2">{results?.groups.flatMap((group) => group.items).map((candidate) => <li key={`${candidate.ref.provider}:${candidate.ref.sourceId}`}><button type="button" disabled={busy || !name.trim()} onClick={() => void create({ kind: "external", ref: candidate.ref, name: candidate.title, releaseYear: candidate.releaseYear })} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left disabled:opacity-50">{candidate.title} <span className="text-sm text-slate-500">{candidate.ref.provider.toUpperCase()}　{candidate.releaseYear ?? "年份未知"}</span></button></li>)}</ul></div><Link href="/lists" onClick={(event) => { if (name.trim() && !window.confirm("空清單會被放棄。仍要離開嗎？")) event.preventDefault(); }} className="inline-block text-sm text-slate-600 underline">返回清單</Link></section>;
}

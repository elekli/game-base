"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { addListMember, archiveList, describeListMember, removeListMember, restoreList, restoreListMember, retryExternalListThumbnail } from "@/app/private-list-actions";
import type { NormalizedSearchCandidate } from "@/modules/games/internal/types";
import { shouldRetainListCommand, type ListMember, type ListRecord, type ListTarget } from "@/modules/lists";
import { GameLifecycleClient } from "@/app/games/game-lifecycle-client";

type SearchResponse = { groups: readonly { items: readonly NormalizedSearchCandidate[]; errorCode: string | null }[] };
type Initial = Readonly<{ list: ListRecord; members: readonly ListMember[] }>;

export function ListDetailClient({ initial, games }: { initial: Initial; games: readonly { id: string; name: string; version: number; trashed: boolean }[] }) {
  const router = useRouter();
  const [record, setRecord] = useState(initial.list);
  const [members, setMembers] = useState(initial.members);
  const [descriptions, setDescriptions] = useState<Record<string, string>>(() => Object.fromEntries(initial.members.map((member) => [member.id, member.description ?? ""])));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingCommand = useRef<{ key: string; id: string } | null>(null);

  function commandId(key: string) {
    if (pendingCommand.current?.key !== key) pendingCommand.current = { key, id: crypto.randomUUID() };
    return pendingCommand.current.id;
  }
  function settle() { pendingCommand.current = null; }
  function reject(code: string, text: string) {
    if (!shouldRetainListCommand(code)) settle();
    setMessage(text);
  }
  function refresh() { settle(); router.refresh(); }
  function memberName(member: ListMember) {
    if (member.target.kind === "external") return member.target.name;
    const gameId = member.target.gameId;
    return games.find((game) => game.id === gameId)?.name ?? "收藏庫遊戲";
  }

  async function changeArchive(restore: boolean) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const action = restore ? restoreList : archiveList;
      const result = await action({ commandId: commandId(`${restore ? "restore" : "archive"}:${record.id}:${record.version}`), listId: record.id, expectedVersion: record.version });
      if (!result.ok) { reject(result.code, result.message); return; }
      setRecord((current) => ({ ...current, version: result.version, archived: restore ? false : true }));
      settle();
    } catch { setMessage("無法確認清單狀態，請重試相同操作。"); }
    finally { setBusy(false); }
  }

  async function changeMember(member: ListMember, restore: boolean) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const action = restore ? restoreListMember : removeListMember;
      const result = await action({ commandId: commandId(`${restore ? "restore" : "remove"}:${member.id}:${member.version}`), memberId: member.id, expectedVersion: member.version });
      if (!result.ok) { reject(result.code, result.message); return; }
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, version: result.version, removed: !restore } : item));
      setRecord((current) => ({ ...current, version: current.version + 1, memberCount: current.memberCount + (restore ? 1 : -1) }));
      settle();
    } catch { setMessage("無法確認成員狀態，請重試相同操作。"); }
    finally { setBusy(false); }
  }

  async function saveDescription(member: ListMember, trashed: boolean) {
    if (busy || member.removed || trashed) return;
    const description = descriptions[member.id]?.trim() || null;
    setBusy(true); setMessage("");
    try {
      const result = await describeListMember({ commandId: commandId(`describe:${member.id}:${member.version}:${description ?? ""}`), memberId: member.id, expectedVersion: member.version, description });
      if (!result.ok) { reject(result.code, result.message); return; }
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, version: result.version, description } : item));
      setDescriptions((current) => ({ ...current, [member.id]: description ?? "" }));
      settle();
      setMessage(description ? "描述已儲存。" : "描述已清除。");
    } catch { setMessage("無法確認描述是否已儲存，請重試相同操作。"); }
    finally { setBusy(false); }
  }

  async function add(target: ListTarget) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const targetKey = target.kind === "game" ? `game:${target.gameId}` : `${target.ref.provider}:${target.ref.sourceId}`;
      const result = await addListMember({ commandId: commandId(`add:${record.id}:${record.version}:${targetKey}`), listId: record.id, expectedVersion: record.version, member: target });
      if (!result.ok) { reject(result.code, result.message); return; }
      refresh();
    } catch { setMessage("無法確認是否已加入，請重試相同操作。"); }
    finally { setBusy(false); }
  }

  async function search() {
    if (busy || !query.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/private/games/search?q=${encodeURIComponent(query.trim())}`);
      if (!response.ok) throw new Error("source_search_failed");
      setResults(await response.json() as SearchResponse);
    } catch { setMessage("來源搜尋失敗，請稍後重試。"); }
    finally { setBusy(false); }
  }

  async function retryThumbnail(member: ListMember) {
    if (busy || member.target.kind !== "external") return;
    setBusy(true); setMessage("");
    try {
      const result = await retryExternalListThumbnail({ ref: member.target.ref });
      if (!result.ok) { setMessage(result.message); return; }
      refresh();
    } catch { setMessage("封面縮圖重試失敗，請稍後再試。"); }
    finally { setBusy(false); }
  }

  const activeGameIds = new Set(members.filter((member) => !member.removed && member.resolvedGameId).map((member) => member.resolvedGameId));
  return <>
    <div className="mt-6 flex items-start justify-between gap-4">
      <div><h1 className="text-3xl font-semibold">{record.name}</h1><p className="mt-2 text-sm text-slate-600">{record.memberCount} 款遊戲{record.archived ? "，已封存" : ""}</p></div>
      <button type="button" disabled={busy} onClick={() => void changeArchive(record.archived)} className="min-h-11 rounded-xl border border-emerald-900 px-4 font-semibold text-emerald-900 disabled:opacity-50">{record.archived ? "還原清單" : "封存清單"}</button>
    </div>
    <p role="status" className="mt-4 min-h-6 text-sm text-amber-800">{message}</p>
    <section className="mt-5" aria-labelledby="members-heading">
      <h2 id="members-heading" className="text-xl font-semibold">清單成員</h2>
      <ul className="mt-3 space-y-3">{members.map((member) => {
        const name = memberName(member);
        const resolvedGame = member.resolvedGameId ? games.find((game) => game.id === member.resolvedGameId) : undefined;
        const trashed = member.trashed || (resolvedGame?.trashed ?? false);
        return <li key={member.id} className={`rounded-2xl border bg-white p-4 ${member.removed ? "border-dashed opacity-70" : trashed ? "border-slate-200 grayscale" : "border-slate-200"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              {member.thumbnailUrl && <Image unoptimized src={member.thumbnailUrl} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0">
                {member.resolvedGameId ? <Link href={`/games/${member.resolvedGameId}`} className="font-semibold underline">{name}</Link> : <p className="font-semibold">{name}</p>}
                <p className="mt-1 text-sm text-slate-500">{member.target.kind === "external" ? `${member.target.ref.provider.toUpperCase()}　${member.target.releaseYear ?? "年份未知"}` : "收藏庫"}{member.thumbnailState === "pending" ? "　封面處理中" : member.thumbnailState === "failed" ? "　封面處理失敗" : ""}{trashed ? "　已移入資源回收區" : ""}{member.removed ? "　已移除" : ""}</p>
                {member.thumbnailState === "failed" && member.target.kind === "external" && <button type="button" disabled={busy} onClick={() => void retryThumbnail(member)} className="mt-2 text-sm font-semibold text-emerald-900 underline disabled:opacity-50">重試封面</button>}
              </div>
            </div>
            <div className="shrink-0">{trashed && member.resolvedGameId && resolvedGame ? <GameLifecycleClient gameId={member.resolvedGameId} version={resolvedGame.version} state="trashed" compact /> : <button type="button" disabled={busy || record.archived} onClick={() => void changeMember(member, member.removed)} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm disabled:opacity-50">{member.removed ? "立即復原" : "移除"}</button>}</div>
          </div>
          <div className="mt-3">
            <label className="block text-sm font-semibold">{name}的描述
              <textarea value={descriptions[member.id] ?? ""} onChange={(event) => setDescriptions((current) => ({ ...current, [member.id]: event.target.value }))} disabled={busy || record.archived || member.removed || trashed} maxLength={1000} rows={2} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal disabled:bg-slate-100" />
            </label>
            <button type="button" disabled={busy || record.archived || member.removed || trashed || (descriptions[member.id]?.trim() || null) === member.description} onClick={() => void saveDescription(member, trashed)} className="mt-2 rounded-xl border border-emerald-900 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:opacity-50">儲存描述</button>
          </div>
        </li>;
      })}</ul>
    </section>
    {!record.archived && <section className="mt-8 rounded-2xl bg-white p-4" aria-labelledby="add-member-heading">
      <h2 id="add-member-heading" className="text-xl font-semibold">加入遊戲</h2>
      <div className="mt-4"><h3 className="font-semibold">從收藏庫加入</h3><ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">{games.filter((game) => !game.trashed && !activeGameIds.has(game.id)).map((game) => <li key={game.id}><button type="button" disabled={busy} onClick={() => void add({ kind: "game", gameId: game.id })} className="w-full rounded-xl border border-slate-200 p-3 text-left disabled:opacity-50">{game.name}</button></li>)}</ul></div>
      <div className="mt-6"><h3 className="font-semibold">搜尋庫外遊戲</h3><div className="mt-2 flex gap-2"><input aria-label="搜尋庫外遊戲" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" /><button type="button" disabled={busy || !query.trim()} onClick={() => void search()} className="rounded-xl bg-emerald-900 px-4 py-3 text-white disabled:opacity-50">搜尋</button></div><ul className="mt-3 space-y-2">{results?.groups.flatMap((group) => group.items).map((candidate) => <li key={`${candidate.ref.provider}:${candidate.ref.sourceId}`}><button type="button" disabled={busy} onClick={() => void add({ kind: "external", ref: candidate.ref, name: candidate.title, releaseYear: candidate.releaseYear })} className="w-full rounded-xl border border-slate-200 p-3 text-left disabled:opacity-50">{candidate.title} <span className="text-sm text-slate-500">{candidate.ref.provider.toUpperCase()}　{candidate.releaseYear ?? "年份未知"}</span></button></li>)}</ul></div>
    </section>}
  </>;
}

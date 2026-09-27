"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { restoreList } from "@/app/private-list-actions";
import { shouldRetainListCommand, type ListRecord } from "@/modules/lists";

export function ArchivedListsClient({ initialLists }: { initialLists: readonly ListRecord[] }) {
  const router = useRouter();
  const [lists, setLists] = useState(initialLists);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const pendingRestore = useRef<{ key: string; id: string } | null>(null);
  if (lists.length === 0) return null;
  async function restore(list: ListRecord) {
    if (busyId) return;
    setBusyId(list.id); setMessage("");
    try {
      const key = `${list.id}:${list.version}`;
      if (pendingRestore.current?.key !== key) pendingRestore.current = { key, id: crypto.randomUUID() };
      const result = await restoreList({ commandId: pendingRestore.current.id, listId: list.id, expectedVersion: list.version });
      if (!result.ok) {
        if (!shouldRetainListCommand(result.code)) pendingRestore.current = null;
        setMessage(result.message);
        return;
      }
      pendingRestore.current = null;
      setLists((current) => current.filter((candidate) => candidate.id !== list.id));
      router.refresh();
    } catch { setMessage("還原失敗，請稍後重試。"); }
    finally { setBusyId(null); }
  }
  return <section className="mt-8 rounded-2xl bg-white p-4" aria-labelledby="archived-lists-heading"><h2 id="archived-lists-heading" className="text-xl font-semibold">相關封存清單</h2><p role="status" className="mt-2 min-h-5 text-sm text-amber-800">{message}</p><ul className="mt-2 space-y-2">{lists.map((list) => <li key={list.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div><Link href={`/lists/${list.id}`} className="font-semibold underline">{list.name}</Link><p className="text-sm text-slate-500">{list.memberCount} 款遊戲</p></div><button type="button" disabled={busyId !== null} onClick={() => void restore(list)} className="min-h-11 shrink-0 rounded-xl border border-emerald-900 px-3 font-semibold text-emerald-900 disabled:opacity-50">還原</button></li>)}</ul></section>;
}

"use client";

import Link from "next/link";
import type { GameRecord } from "@/modules/games";
import { GameLifecycleClient } from "@/app/games/game-lifecycle-client";

export function TrashClient({ games, focus }: { games: readonly GameRecord[]; focus: string | null }) {
  if (games.length === 0) return <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-600">資源回收區目前沒有遊戲。</p>;
  return <ul className="space-y-3">{games.map((game) => <li id={`trash-${game.id}`} key={game.id} className={`rounded-2xl border bg-white p-4 ${focus === game.id ? "border-emerald-700 ring-2 ring-emerald-100" : "border-slate-200"}`}><div className="flex items-start justify-between gap-3"><div><Link href={`/games/${game.id}`} className="font-semibold underline">{game.displayName}</Link><p className="mt-1 text-sm text-slate-500">已移入資源回收區</p></div><GameLifecycleClient gameId={game.id} version={game.version} state="trashed" compact /></div></li>)}</ul>;
}

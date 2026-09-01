"use client";

import Link from "next/link";
import { useState } from "react";
import type { GameRecord, Medium, SharedLibraryItem, SourceCategory } from "@/modules/games";
import type { LibraryFilters } from "@/modules/library";
import { deletePlatform, deleteTag } from "@/app/private-mutation-actions";
import type { PrivateActionResult } from "@/shared/auth/private-action";

type Props = Readonly<{ games: readonly GameRecord[]; sourceCategories: readonly SourceCategory[]; filters: LibraryFilters; sharedPlatforms: readonly SharedLibraryItem[]; sharedTags: readonly SharedLibraryItem[] }>;

const mediumLabels: Record<Medium, string> = { board_game: "桌遊", video_game: "電子遊戲" };

function unwrapPrivateAction<Success extends object>(result: PrivateActionResult<Success>): Success {
  if (!result.ok) throw new Error(result.message);
  return result;
}

export function LibraryClient({ games, sourceCategories, filters, sharedPlatforms, sharedTags }: Props) {
  const [message, setMessage] = useState("");
  const selectedMedia = filters.media ?? [];
  const selectedCategories = new Set((filters.sourceCategories ?? []).map((category) => `${category.kind}:${category.sourceCategoryId}`));
  async function deleteShared(item: SharedLibraryItem, action: typeof deletePlatform | typeof deleteTag) {
    if (item.isSystem || !window.confirm(`確定刪除「${item.name}」？`)) return;
    unwrapPrivateAction(await action({ name: item.name }));
    window.location.reload();
  }
  return <>
    <form className="mb-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-4" role="search">
      <fieldset><legend className="mb-2 text-sm font-medium">遊戲類型</legend><div className="flex flex-wrap gap-3">{(Object.keys(mediumLabels) as Medium[]).map((medium) => <label className="flex items-center gap-2 text-sm" key={medium}><input type="checkbox" name="medium" value={medium} defaultChecked={selectedMedia.includes(medium)} />{mediumLabels[medium]}</label>)}</div></fieldset>
      {sourceCategories.length > 0 && <fieldset><legend className="mb-2 text-sm font-medium">來源分類</legend><div className="grid grid-cols-2 gap-2">{sourceCategories.map((category) => <label className="flex items-center gap-2 text-sm" key={`${category.kind}:${category.sourceCategoryId}`}><input type="checkbox" name="category" value={`${category.kind}:${category.sourceCategoryId}`} defaultChecked={selectedCategories.has(`${category.kind}:${category.sourceCategoryId}`)} />{category.name}</label>)}</div></fieldset>}
      <div className="flex items-center gap-3"><label className="text-sm font-medium" htmlFor="library-sort">排序</label><select id="library-sort" name="sort" defaultValue={filters.sort ?? "name"} className="rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="name">名稱</option><option value="recent">最近新增</option>{selectedMedia.length === 1 && selectedMedia[0] === "board_game" && <><option value="weight_asc">重度：輕到重</option><option value="weight_desc">重度：重到輕</option><option value="strategy_rank">Strategy Game Rank</option></>}</select>{selectedMedia.length === 1 && selectedMedia[0] === "board_game" && <><label className="sr-only" htmlFor="weight-min">最低重度</label><input id="weight-min" name="weightMin" inputMode="decimal" placeholder="最低重度" className="w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm" defaultValue={filters.weightMin ?? ""} /><label className="sr-only" htmlFor="weight-max">最高重度</label><input id="weight-max" name="weightMax" inputMode="decimal" placeholder="最高重度" className="w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm" defaultValue={filters.weightMax ?? ""} /></>}</div>
    </form>
    {message && <p role="status" className="mb-4 text-sm text-rose-700">{message}</p>}<details className="mb-6 rounded-2xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">管理共享平台與標籤</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-medium">平台</h2><ul className="mt-2 space-y-2 text-sm">{sharedPlatforms.map((item) => <li className="flex items-center justify-between gap-2" key={item.name}><span>{item.name} <span className="text-slate-500">（{item.usageCount} 款使用）</span></span>{!item.isSystem && <button type="button" className="text-rose-700" onClick={() => void deleteShared(item, deletePlatform).catch((error) => setMessage(error instanceof Error ? error.message : "刪除失敗。"))}>刪除</button>}</li>)}</ul></div><div><h2 className="text-sm font-medium">標籤</h2><ul className="mt-2 space-y-2 text-sm">{sharedTags.map((item) => <li className="flex items-center justify-between gap-2" key={item.name}><span>{item.name} <span className="text-slate-500">（{item.usageCount} 款使用）</span></span><button type="button" className="text-rose-700" onClick={() => void deleteShared(item, deleteTag).catch((error) => setMessage(error instanceof Error ? error.message : "刪除失敗。"))}>刪除</button></li>)}</ul></div></div></details>
    {games.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-8 text-center text-slate-600">沒有符合條件的遊戲。</p> : <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">{games.map((game) => <li key={game.id}><Link href={`/games/${game.id}`} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="aspect-[4/5] rounded-xl bg-emerald-50" /><h2 className="mt-3 font-semibold">{game.displayName}</h2><p className="mt-1 text-sm text-slate-500">{mediumLabels[game.medium]}{game.medium === "board_game" && game.snapshot?.weight !== null && game.snapshot?.weight !== undefined ? ` · 重度 ${game.snapshot.weight}` : ""}</p>{game.medium === "video_game" && game.actualPlatforms.length > 0 && <p className="mt-1 truncate text-xs text-slate-500">{game.actualPlatforms.join("、")}</p>}</Link></li>)}</ul>}
  </>;
}

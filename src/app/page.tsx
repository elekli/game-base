import Link from "next/link";
import { gamesService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePrivatePage();
  const { q = "" } = await searchParams;
  const games = await gamesService.listGames(q);
  return <main className="mx-auto min-h-screen max-w-3xl px-4 py-8 sm:px-6"><header className="mb-8 flex items-end justify-between gap-4"><div><p className="text-xs font-semibold tracking-[0.2em] text-emerald-800">PUIZERU GAMEBASE</p><h1 className="mt-2 text-3xl font-semibold">我的收藏庫</h1></div><Link className="rounded-full bg-emerald-900 px-4 py-2 text-sm font-semibold text-white" href="/games/new">新增遊戲</Link></header><form className="mb-6 flex gap-2" role="search"><label className="sr-only" htmlFor="library-search">搜尋收藏庫</label><input id="library-search" name="q" defaultValue={q} placeholder="搜尋名稱" className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3" /><button className="rounded-xl border border-slate-300 bg-white px-4 py-3 font-medium" type="submit">搜尋</button></form>{games.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-8 text-center text-slate-600">收藏庫還是空的，先新增一款遊戲吧。</p> : <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">{games.map((game) => <li key={game.id}><Link href={`/games/${game.id}`} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="aspect-[4/5] rounded-xl bg-emerald-50" /><h2 className="mt-3 font-semibold">{game.displayName}</h2><p className="mt-1 text-sm text-slate-500">{game.medium === "board_game" ? "桌遊" : "電子遊戲"}</p></Link></li>)}</ul>}</main>;
}

import Link from "next/link";
import { requirePrivatePage } from "@/app/games/private-page";
import { listsService } from "./service";

export const dynamic = "force-dynamic";

export default async function ListsPage() {
  await requirePrivatePage();
  const lists = await listsService.list();
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/" className="text-sm text-slate-600">← 收藏庫</Link><div className="mt-6 flex items-center justify-between gap-3"><h1 className="text-3xl font-semibold">一般清單</h1><Link href="/lists/new" className="rounded-full bg-emerald-900 px-4 py-2 text-sm font-semibold text-white">新增清單</Link></div>{lists.length === 0 ? <p className="mt-8 rounded-2xl bg-white p-6 text-slate-600">尚無清單。輸入名稱並選取第一款遊戲後才會建立。</p> : <ul className="mt-8 space-y-3">{lists.map((list) => <li key={list.id}><Link href={`/lists/${list.id}`} className="flex min-h-16 items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-3"><span className="font-semibold">{list.name}</span><span className="text-sm text-slate-500">{list.memberCount} 款遊戲</span></Link></li>)}</ul>}</main>;
}

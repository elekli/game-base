import Link from "next/link";
import { gamesService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";
import { NewListClient } from "./new-list-client";

export const dynamic = "force-dynamic";

export default async function NewListPage() {
  await requirePrivatePage();
  const games = await gamesService.listGames();
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/lists" className="text-sm text-slate-600">← 一般清單</Link><h1 className="mt-6 text-3xl font-semibold">新增清單</h1><p className="mt-2 text-slate-600">名稱會先留在此頁。選取第一款遊戲後，才會建立清單。</p><NewListClient games={games.map((game) => ({ id: game.id, name: game.displayName, trashed: game.trashedAt !== null }))} /></main>;
}

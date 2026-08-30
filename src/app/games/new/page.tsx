import Link from "next/link";
import { gamesService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";
import { AddGameClient } from "./add-game-client";

export const dynamic = "force-dynamic";

export default async function NewGamePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePrivatePage();
  const { q = "" } = await searchParams;
  const results = q ? await gamesService.searchExternalGames({ query: q }) : null;
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><div className="mb-8 flex items-center gap-3"><Link href="/" className="text-sm text-slate-600">← 收藏庫</Link><h1 className="text-3xl font-semibold">新增遊戲</h1></div><AddGameClient query={q} results={results} /></main>;
}

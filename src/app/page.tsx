import Link from "next/link";
import { libraryService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";
import { LibraryClient, parseLibrarySearchParams } from "./library-client";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePrivatePage();
  const filters = parseLibrarySearchParams(await searchParams);
  const [games, facets] = await Promise.all([libraryService.listGames(filters), libraryService.listGames()]);
  return <main className="mx-auto min-h-screen max-w-3xl px-4 py-8 sm:px-6"><header className="mb-8 flex items-end justify-between gap-4"><div><p className="text-xs font-semibold tracking-[0.2em] text-emerald-800">PUIZERU GAMEBASE</p><h1 className="mt-2 text-3xl font-semibold">我的收藏庫</h1></div><Link className="rounded-full bg-emerald-900 px-4 py-2 text-sm font-semibold text-white" href="/games/new">新增遊戲</Link></header><LibraryClient games={games} facets={facets} filters={filters} /></main>;
}

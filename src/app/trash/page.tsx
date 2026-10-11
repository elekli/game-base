import Link from "next/link";
import { requirePrivatePage } from "@/app/games/private-page";
import { gamesService } from "@/app/games/service";
import { TrashClient } from "./trash-client";
import { productionCanaryPageFixtures } from "@/app/production-canary/page-fixtures";

export const dynamic = "force-dynamic";

export default async function TrashPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const owner = await requirePrivatePage();
  const [{ focus }, games, canaryGames] = await Promise.all([
    searchParams,
    gamesService.listTrashedGames(),
    productionCanaryPageFixtures(owner.sub),
  ]);
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/" className="text-sm text-slate-600">← 收藏庫</Link><header className="my-8"><h1 className="text-3xl font-semibold">資源回收區</h1><p className="mt-2 text-sm text-slate-600">還原後，原有筆記、媒體、清單與關聯會重新出現在一般介面。</p></header><TrashClient games={[...games, ...canaryGames.filter((game) => game.trashedAt !== null)]} focus={focus ?? null} /></main>;
}

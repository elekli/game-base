import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePrivatePage } from "@/app/games/private-page";
import { gamesService } from "@/app/games/service";
import { listsService } from "@/app/lists/service";
import { ListDetailClient } from "./list-detail-client";

export const dynamic = "force-dynamic";

export default async function ListDetailPage({ params }: { params: Promise<{ listId: string }> }) {
  await requirePrivatePage();
  const { listId } = await params;
  const [record, games] = await Promise.all([listsService.get(listId), gamesService.listGames()]);
  if (!record) notFound();
  const stateKey = `${record.list.version}:${record.members.map((member) => `${member.id}:${member.version}:${member.thumbnailState}:${member.thumbnailUrl ?? "none"}`).join(",")}`;
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/lists" className="text-sm text-slate-600">← 一般清單</Link><ListDetailClient key={stateKey} initial={record} games={games.map((game) => ({ id: game.id, name: game.displayName, trashed: game.trashedAt !== null }))} /></main>;
}

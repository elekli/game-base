import Link from "next/link";
import { notFound } from "next/navigation";
import { gamesService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";

export const dynamic = "force-dynamic";

export default async function GameDetailPage({ params }: { params: Promise<{ gameId: string }> }) {
  await requirePrivatePage();
  const { gameId } = await params;
  const game = await gamesService.getGame(gameId);
  if (!game) notFound();
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/" className="text-sm text-slate-600">← 收藏庫</Link><div className="mt-8 aspect-[16/9] rounded-3xl bg-emerald-50" /><div className="mt-6 flex items-start justify-between gap-4"><div><p className="text-sm text-emerald-800">{game.medium === "board_game" ? "桌遊" : "電子遊戲"}</p><h1 className="mt-1 text-3xl font-semibold">{game.displayName}</h1></div>{game.snapshot?.releaseYear && <p className="text-slate-500">{game.snapshot.releaseYear}</p>}</div>{game.snapshot?.description && <p className="mt-6 leading-7 text-slate-700">{game.snapshot.description}</p>}<dl className="mt-8 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">來源</dt><dd className="mt-1 font-medium">{game.snapshot?.ref.provider.toUpperCase() ?? "手動"}</dd></div><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">封面</dt><dd className="mt-1 font-medium">{game.snapshot?.coverUrl ? "處理中" : "尚無"}</dd></div></dl></main>;
}

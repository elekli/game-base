import Link from "next/link";
import { notFound } from "next/navigation";
import { gamesService } from "@/app/games/service";
import { requirePrivatePage } from "@/app/games/private-page";
import { sanitizeSourceDescription } from "@/modules/games";
import { GameEditClient } from "@/app/games/game-edit-client";

export const dynamic = "force-dynamic";

export default async function GameDetailPage({ params }: { params: Promise<{ gameId: string }> }) {
  await requirePrivatePage();
  const { gameId } = await params;
  const game = await gamesService.getGame(gameId);
  if (!game) notFound();
  const description = game.snapshot?.description ? sanitizeSourceDescription(game.snapshot.description) : "";
  return <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:px-6"><Link href="/" className="text-sm text-slate-600">← 收藏庫</Link><div className="mt-8 aspect-[16/9] rounded-3xl bg-emerald-50" /><div className="mt-6 flex items-start justify-between gap-4"><div><p className="text-sm text-emerald-800">{game.medium === "board_game" ? "桌遊" : "電子遊戲"}</p><h1 className="mt-1 text-3xl font-semibold">{game.displayName}</h1></div>{game.snapshot?.releaseYear && <p className="text-slate-500">{game.snapshot.releaseYear}</p>}</div><dl className="mt-8 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">來源</dt><dd className="mt-1 font-medium">{game.snapshot?.ref.provider.toUpperCase() ?? "手動"}</dd></div><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">封面</dt><dd className="mt-1 font-medium">{game.snapshot?.coverUrl ? "處理中" : "尚無"}</dd></div><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">實際平台</dt><dd className="mt-1 font-medium">{game.actualPlatforms.length > 0 ? game.actualPlatforms.join("、") : "尚未設定"}</dd></div><div className="rounded-xl bg-white p-4"><dt className="text-slate-500">自由標籤</dt><dd className="mt-1 font-medium">{game.tags.length > 0 ? game.tags.join("、") : "尚未設定"}</dd></div>{game.snapshot && <div className="col-span-2 rounded-xl bg-white p-4"><dt className="text-slate-500">來源支援平台（僅供參考）</dt><dd className="mt-1 font-medium">{game.snapshot.supportedPlatforms.length > 0 ? game.snapshot.supportedPlatforms.join("、") : "尚未提供"}</dd></div>}</dl>{description && <details className="mt-6 rounded-xl bg-white p-4"><summary className="cursor-pointer font-semibold">來源介紹</summary><p className="mt-3 whitespace-pre-wrap leading-7 text-slate-700">{description}</p></details>}<GameEditClient game={game} /></main>;
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NormalizedSearchCandidate, Provider } from "@/modules/games";

type Groups = Readonly<{ groups: readonly { provider: Provider; items: readonly NormalizedSearchCandidate[]; errorCode: string | null }[] }> | null;

export function AddGameClient({ query, results }: Readonly<{ query: string; results: Groups }>) {
  const [message, setMessage] = useState("");
  const router = useRouter();
  async function add(ref: NormalizedSearchCandidate["ref"]) {
    setMessage("正在取得來源確認…");
    try {
      const confirmation = await fetch("/api/private/games/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ref) });
      if (!confirmation.ok) { setMessage("來源確認失敗，請稍後再試。"); return; }
      const payload = await confirmation.json() as { fingerprint: string };
      const created = await fetch("/api/private/games/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ref, confirmationFingerprint: payload.fingerprint }) });
      if (!created.ok) { setMessage(created.status === 409 ? "來源內容已更新或已存在，請重新確認。" : "建立失敗，請稍後再試。"); return; }
      const result = await created.json() as { identityConflict?: string | null };
      if (result.identityConflict) { setMessage(result.identityConflict === "trashed" ? "此來源在資源回收區，請先還原。" : "此來源已在收藏庫中。"); return; }
      router.push("/");
    } catch { setMessage("網路暫時無法使用，請稍後再試。"); }
  }
  async function manual(form: FormData) {
    try {
      const response = await fetch("/api/private/games/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: form.get("manualName"), medium: form.get("medium") }) });
      if (!response.ok) { setMessage("手動建立失敗。"); return; }
      router.push("/");
    } catch { setMessage("網路暫時無法使用，請稍後再試。"); }
  }
  return <><form className="flex gap-2"><label className="sr-only" htmlFor="game-query">搜尋遊戲</label><input id="game-query" name="q" defaultValue={query} placeholder="輸入遊戲名稱" className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3" /><button className="rounded-xl bg-emerald-900 px-4 py-3 font-semibold text-white" type="submit">同時搜尋</button></form><p role="status" className="mt-3 text-sm text-slate-600">{message}</p><section className="mt-8 space-y-6" aria-live="polite">{results?.groups.map((group) => <div key={group.provider}><div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-semibold">{group.provider === "bgg" ? "BoardGameGeek 桌遊" : "IGDB 電子遊戲"}</h2>{group.errorCode && <p className="text-sm text-amber-800">此來源暫時無法使用（{group.errorCode}）</p>}</div>{group.items.length === 0 ? <p className="rounded-xl bg-white/60 p-4 text-sm text-slate-600">沒有找到結果。</p> : <ul className="space-y-2">{group.items.map((item) => <li key={`${item.ref.provider}:${item.ref.sourceId}`} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4"><span><strong>{item.title}</strong>{item.releaseYear && <span className="ml-2 text-sm text-slate-500">{item.releaseYear}</span>}</span><button type="button" onClick={() => void add(item.ref)} className="rounded-full bg-slate-100 px-3 py-1 text-xs">展開確認並加入</button></li>)}</ul>}</div>)}</section><details className="mt-8 rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">找不到？建立手動條目</summary><form action={manual} className="mt-4 space-y-3"><input name="manualName" placeholder="遊戲名稱" className="w-full rounded-xl border border-slate-300 px-4 py-3" required /><select name="medium" className="w-full rounded-xl border border-slate-300 px-4 py-3" defaultValue="board_game"><option value="board_game">桌遊</option><option value="video_game">電子遊戲</option></select><button className="w-full rounded-xl bg-emerald-900 px-4 py-3 font-semibold text-white" type="submit">建立手動條目</button></form></details></>;
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { moveGameToTrash, restoreGame } from "@/app/private-mutation-actions";
import type { TrashConfirmation } from "@/modules/games";

type Props = Readonly<{
  gameId: string;
  version: number;
  state: "active" | "trashed";
  counts?: TrashConfirmation["counts"];
  compact?: boolean;
}>;

export function GameLifecycleClient({ gameId, version, state, counts, compact = false }: Props) {
  const router = useRouter();
  const command = useRef<{ key: string; id: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  function commandId() {
    const key = `${state}:${gameId}:${version}`;
    if (command.current?.key !== key) command.current = { key, id: crypto.randomUUID() };
    return command.current.id;
  }
  async function submit() {
    if (busy) return;
    setBusy(true); setMessage("");
    const action = state === "active" ? moveGameToTrash : restoreGame;
    try {
      const result = await action({ commandId: commandId(), gameId, expectedVersion: version });
      if (!result.ok) {
        if (result.code !== "operation_failed") command.current = null;
        setMessage(result.message);
        if (result.code === "command_version_conflict") router.refresh();
        return;
      }
      command.current = null;
      router.push(state === "active" ? `/trash?focus=${gameId}` : `/games/${gameId}`);
      router.refresh();
    } catch {
      setMessage("網路暫時無法使用，請重試。操作識別碼已保留，不會重複執行。");
    } finally { setBusy(false); }
  }
  if (state === "trashed" || compact) return <div className="mt-2"><button type="button" disabled={busy} onClick={() => void submit()} className="min-h-10 rounded-xl border border-emerald-900 px-3 text-sm font-semibold text-emerald-900 disabled:opacity-50">還原</button>{message && <p role="status" className="mt-2 text-sm text-rose-800">{message}</p>}</div>;
  return <section className="mt-10 rounded-2xl border border-rose-200 bg-white p-4" aria-labelledby="trash-heading">
    <h2 id="trash-heading" className="font-semibold">資源回收區</h2>
    {!confirming ? <button type="button" onClick={() => setConfirming(true)} className="mt-3 min-h-11 rounded-xl border border-rose-700 px-4 font-semibold text-rose-700">移入資源回收區</button> : <div className="mt-3 rounded-xl bg-rose-50 p-4">
      <p className="font-medium">移入後會從一般介面隱藏，以下資料仍完整保留：</p>
      <ul className="mt-2 grid grid-cols-2 gap-2 text-sm"><li>筆記：{counts?.notes ?? 0}</li><li>照片：{counts?.photos ?? 0}</li><li>附件：{counts?.attachments ?? 0}</li><li>清單：{counts?.lists ?? 0}</li><li>關聯：{counts?.relations ?? 0}</li></ul>
      <div className="mt-4 flex gap-2"><button type="button" disabled={busy} onClick={() => void submit()} className="min-h-11 rounded-xl bg-rose-700 px-4 font-semibold text-white disabled:opacity-50">確認移入</button><button type="button" disabled={busy} onClick={() => setConfirming(false)} className="min-h-11 px-4 text-sm font-semibold">取消</button></div>
    </div>}
    {message && <p role="status" className="mt-3 text-sm text-rose-800">{message}</p>}
  </section>;
}

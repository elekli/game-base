"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createNote, removeNote, restoreNote, updateNote } from "@/app/private-note-actions";
import type { NoteRecord } from "@/modules/notes";

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "failed" | "conflict" | "removal_pending" | "removed";
type Failure = Readonly<{ message: string; currentNote?: NoteRecord }>;

function NoteEditor({ gameId, initial, onDiscard }: Readonly<{ gameId: string; initial?: NoteRecord; onDiscard?: () => void }>) {
  const [noteId, setNoteId] = useState(initial?.id ?? null);
  const [content, setContent] = useState(initial?.content ?? "");
  const [savedContent, setSavedContent] = useState(initial?.content ?? "");
  const [version, setVersion] = useState(initial?.version ?? 0);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [failureAction, setFailureAction] = useState<"save" | "remove" | "restore" | null>(null);
  const pendingCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const lifecycleCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);

  const unsettled = status === "pending" || status === "saving" || status === "failed" || status === "conflict" || status === "removal_pending";

  const save = useCallback(async (forceVersion?: number) => {
    if (!content.trim() || status === "saving" || status === "removed") return;
    const fingerprint = JSON.stringify({ noteId, version: forceVersion ?? version, content });
    if (pendingCommand.current?.fingerprint !== fingerprint) pendingCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    const command = pendingCommand.current;
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try {
      result = noteId
        ? await updateNote({ commandId: command.commandId, noteId, expectedVersion: forceVersion ?? version, content })
        : await createNote({ commandId: command.commandId, gameId, content });
    } catch {
      setFailure({ message: "無法確認筆記是否已儲存，請用相同操作重試。" });
      setFailureAction("save");
      setStatus("failed");
      return;
    }
    if (!result.ok) {
      setFailure({ message: result.message, currentNote: result.currentNote });
      setFailureAction("save");
      setStatus(result.code === "command_version_conflict" && result.currentNote ? "conflict" : "failed");
      return;
    }
    setNoteId(result.resourceId);
    setVersion(result.version);
    setSavedContent(content);
    pendingCommand.current = null;
    setFailureAction(null);
    setStatus("saved");
  }, [content, gameId, noteId, status, version]);

  useEffect(() => {
    if (status !== "pending" || !content.trim()) return;
    const timer = window.setTimeout(() => void save(), 600);
    return () => window.clearTimeout(timer);
  }, [content, save, status]);

  useEffect(() => {
    if (!unsettled) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const beforeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;
      if (!window.confirm(status === "removal_pending" ? "筆記已清空但尚未確認移除。仍要離開並保留原文嗎？" : "筆記仍有未儲存內容。仍要離開嗎？")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLink, true);
    };
  }, [status, unsettled]);

  function changeText(value: string) {
    setContent(value);
    setFailure(null);
    setFailureAction(null);
    if (!value.trim()) {
      pendingCommand.current = null;
      setStatus(noteId ? "removal_pending" : "idle");
    } else {
      setStatus(value === savedContent ? "idle" : "pending");
    }
  }

  async function remove() {
    if (!noteId) { onDiscard?.(); return; }
    const fingerprint = `remove:${noteId}:${version}`;
    if (lifecycleCommand.current?.fingerprint !== fingerprint) lifecycleCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try { result = await removeNote({ commandId: lifecycleCommand.current.commandId, noteId, expectedVersion: version }); }
    catch { setFailure({ message: "無法確認筆記是否已移除，請用相同操作重試。" }); setFailureAction("remove"); setStatus("failed"); return; }
    if (!result.ok) { setFailure({ message: result.message, currentNote: result.currentNote }); setFailureAction("remove"); setStatus("failed"); return; }
    setVersion(result.version);
    setContent(savedContent);
    lifecycleCommand.current = null;
    setStatus("removed");
  }

  async function restore() {
    if (!noteId) return;
    const fingerprint = `restore:${noteId}:${version}`;
    if (lifecycleCommand.current?.fingerprint !== fingerprint) lifecycleCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try { result = await restoreNote({ commandId: lifecycleCommand.current.commandId, noteId, expectedVersion: version }); }
    catch { setFailure({ message: "無法確認筆記是否已還原，請用相同操作重試。" }); setFailureAction("restore"); setStatus("failed"); return; }
    if (!result.ok) { setFailure({ message: result.message, currentNote: result.currentNote }); setFailureAction("restore"); setStatus("failed"); return; }
    setVersion(result.version);
    lifecycleCommand.current = null;
    setStatus("saved");
  }

  function retryFailure() {
    if (failureAction === "remove") return void remove();
    if (failureAction === "restore") return void restore();
    return void save();
  }

  if (status === "removed") return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm"><p>筆記已移除，原文仍安全保留。</p><button type="button" onClick={() => void restore()} className="mt-3 min-h-11 rounded-xl bg-amber-900 px-4 font-semibold text-white">立即復原</button></div>;

  const label = status === "saving" ? "儲存中……" : status === "saved" ? "已儲存" : status === "failed" ? "儲存失敗" : status === "conflict" ? "版本衝突" : status === "removal_pending" ? "待確認移除" : status === "pending" && content.trim() ? "等待儲存" : "";
  return <article className="rounded-2xl border border-slate-200 bg-white p-4">
    <textarea aria-label={initial ? "編輯筆記" : "新增筆記內容"} value={content} onChange={(event) => changeText(event.target.value)} disabled={status === "saving"} rows={6} placeholder="用 Markdown 記下心得……" className="w-full resize-y rounded-xl border border-slate-300 p-3 leading-7 disabled:bg-slate-50" />
    <div className="mt-2 flex min-h-6 items-center justify-between gap-3 text-sm"><span aria-live="polite" className={status === "failed" || status === "conflict" ? "font-semibold text-red-700" : "text-slate-600"}>{label}</span>{status === "failed" && <button type="button" onClick={retryFailure} className="font-semibold text-emerald-800">重試</button>}</div>
    {failure && <p className="mt-1 text-sm text-red-700">{failure.message}</p>}
    {status === "removal_pending" && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void remove()} className="min-h-11 rounded-xl bg-red-800 px-4 font-semibold text-white">確認移除</button><button type="button" onClick={() => { setContent(savedContent); setStatus("idle"); }} className="min-h-11 rounded-xl border px-4 font-semibold">保留原文</button></div>}
    {status === "conflict" && failure?.currentNote && <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm"><p className="font-semibold">伺服器版本</p><p className="mt-1 whitespace-pre-wrap">{failure.currentNote.content}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => { setContent(failure.currentNote!.content); setSavedContent(failure.currentNote!.content); setVersion(failure.currentNote!.version); setFailure(null); setStatus("idle"); }} className="min-h-11 rounded-xl border px-3 font-semibold">載入伺服器版本</button><button type="button" onClick={() => { setVersion(failure.currentNote!.version); pendingCommand.current = null; void save(failure.currentNote!.version); }} className="min-h-11 rounded-xl bg-emerald-900 px-3 font-semibold text-white">保留我的內容並重送</button></div></div>}
    {!noteId && !content.trim() && <button type="button" onClick={onDiscard} className="mt-2 text-sm text-slate-600">放棄空白草稿</button>}
  </article>;
}

export function NotesClient({ gameId, initialNotes }: Readonly<{ gameId: string; initialNotes: readonly NoteRecord[] }>) {
  const [draft, setDraft] = useState(false);
  useEffect(() => {
    const openDraft = () => {
      if (window.location.hash === "#notes-heading") setDraft(true);
    };
    openDraft();
    window.addEventListener("hashchange", openDraft);
    return () => window.removeEventListener("hashchange", openDraft);
  }, []);
  return <section id="notes-heading" className="mt-10" aria-labelledby="notes-title"><div className="flex items-center justify-between"><h2 id="notes-title" className="text-xl font-semibold">筆記</h2><button type="button" onClick={() => setDraft(true)} disabled={draft} className="min-h-11 rounded-xl bg-emerald-900 px-4 font-semibold text-white disabled:opacity-50">新增筆記</button></div><div className="mt-4 grid gap-4">{initialNotes.map((note) => <NoteEditor key={note.id} gameId={gameId} initial={note} />)}{draft && <NoteEditor gameId={gameId} onDiscard={() => setDraft(false)} />}{!draft && initialNotes.length === 0 && <p className="rounded-2xl bg-white p-4 text-slate-600">尚無筆記。</p>}</div></section>;
}

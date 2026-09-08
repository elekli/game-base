"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createNote, removeNote, restoreNote, updateNote } from "@/app/private-note-actions";
import type { NoteRecord } from "@/modules/notes";

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "failed" | "conflict" | "removal_pending" | "removed";
type Failure = Readonly<{ message: string; currentNote?: NoteRecord }>;
type PendingSave = { fingerprint: string; commandId: string; noteId: string | null; version: number; content: string };

const historyPositionKey = "__puizeruHistoryPosition";
type NavigationGuardState = {
  installed: boolean;
  historyPosition: number;
  lastHistoryDelta: number;
  suppressedHistoryPosition: number | null;
  suppressedHistoryUrl: string | null;
  currentUrl: string;
  unsettledEditors: Map<symbol, boolean>;
};
type GuardedWindow = Window & {
  navigation?: { addEventListener(type: "navigate", listener: EventListener): void };
  __disableNavigationApiForTests?: boolean;
  __puizeruNavigationGuardState?: NavigationGuardState;
};

function navigationGuardState() {
  const guardedWindow = window as GuardedWindow;
  guardedWindow.__puizeruNavigationGuardState ??= {
    installed: false,
    historyPosition: 0,
    lastHistoryDelta: -1,
    suppressedHistoryPosition: null,
    suppressedHistoryUrl: null,
    currentUrl: window.location.href,
    unsettledEditors: new Map(),
  };
  return guardedWindow.__puizeruNavigationGuardState;
}

function leaveMessage() {
  return [...navigationGuardState().unsettledEditors.values()].some(Boolean)
    ? "筆記已清空但尚未確認移除。仍要離開並保留原文嗎？"
    : "筆記仍有未儲存內容。仍要離開嗎？";
}

export function installHistoryTracking() {
  const guard = navigationGuardState();
  if (guard.installed) return;
  guard.installed = true;
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  guard.historyPosition = typeof state[historyPositionKey] === "number" ? state[historyPositionKey] : 0;
  if (state[historyPositionKey] === undefined) window.history.replaceState({ ...state, [historyPositionKey]: guard.historyPosition }, "");
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);
  window.history.pushState = (data, unused, url) => {
    guard.historyPosition += 1;
    originalPushState({ ...(data ?? {}), [historyPositionKey]: guard.historyPosition }, unused, url);
    guard.currentUrl = window.location.href;
  };
  window.history.replaceState = (data, unused, url) => {
    originalReplaceState({ ...(data ?? {}), [historyPositionKey]: guard.historyPosition }, unused, url);
    guard.currentUrl = window.location.href;
  };
  const beforeHistory = (event: PopStateEvent) => {
    const sourceUrl = guard.currentUrl;
    const destination = (event.state ?? {}) as Record<string, unknown>;
    const nextPosition = destination[historyPositionKey];
    if (typeof nextPosition === "number") {
      guard.lastHistoryDelta = nextPosition - guard.historyPosition || -1;
      guard.historyPosition = nextPosition;
    } else {
      guard.lastHistoryDelta = -1;
    }
    if (typeof nextPosition === "number" && guard.suppressedHistoryPosition === nextPosition) {
      const restoredUrl = guard.suppressedHistoryUrl;
      guard.suppressedHistoryPosition = null;
      guard.suppressedHistoryUrl = null;
      guard.currentUrl = restoredUrl ?? window.location.href;
      event.stopImmediatePropagation();
      if (restoredUrl) {
        window.setTimeout(() => {
          if (window.location.href !== restoredUrl) {
            originalReplaceState(window.history.state, "", restoredUrl);
          }
          guard.currentUrl = window.location.href;
        }, 100);
      }
      return;
    }
    guard.suppressedHistoryPosition = null;
    guard.suppressedHistoryUrl = null;
    if (guard.unsettledEditors.size === 0) {
      guard.currentUrl = window.location.href;
      return;
    }
    const compensationDelta = -guard.lastHistoryDelta;
    const sourcePosition = guard.historyPosition + compensationDelta;
    if (!window.confirm(leaveMessage())) {
      event.stopImmediatePropagation();
      guard.suppressedHistoryPosition = sourcePosition;
      guard.suppressedHistoryUrl = sourceUrl;
      window.setTimeout(() => window.history.go(compensationDelta), 50);
    } else {
      guard.currentUrl = window.location.href;
    }
  };
  const beforeNavigate = (event: Event) => {
    const navigationEvent = event as Event & { navigationType?: string };
    if (navigationEvent.navigationType === "traverse" && guard.unsettledEditors.size > 0 && !window.confirm(leaveMessage())) event.preventDefault();
  };
  const beforeLink = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor || anchor.target === "_blank" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (guard.unsettledEditors.size > 0 && !window.confirm(leaveMessage())) {
      event.preventDefault();
      return;
    }
    const sourceUrl = new URL(window.location.href);
    const destinationUrl = new URL(anchor.href, sourceUrl);
    const isNativeFragment = destinationUrl.origin === sourceUrl.origin
      && destinationUrl.pathname === sourceUrl.pathname
      && destinationUrl.search === sourceUrl.search
      && destinationUrl.hash !== sourceUrl.hash;
    if (!isNativeFragment) return;
    event.preventDefault();
    window.history.pushState(window.history.state, "", destinationUrl.href);
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: sourceUrl.href, newURL: destinationUrl.href }));
    document.getElementById(decodeURIComponent(destinationUrl.hash.slice(1)))?.scrollIntoView();
  };
  const controlledWindow = window as GuardedWindow;
  const navigation = controlledWindow.__disableNavigationApiForTests ? undefined : controlledWindow.navigation;
  window.addEventListener("beforeunload", (event) => {
    if (guard.unsettledEditors.size > 0) event.preventDefault();
  });
  if (navigation) navigation.addEventListener("navigate", beforeNavigate);
  else window.addEventListener("popstate", beforeHistory, true);
  document.addEventListener("click", beforeLink, true);
}

if (typeof window !== "undefined") installHistoryTracking();

function NoteEditor({ gameId, initial, onCreated, onDiscard }: Readonly<{ gameId: string; initial?: NoteRecord; onCreated?: (note: NoteRecord) => void; onDiscard?: () => void }>) {
  const [noteId, setNoteId] = useState(initial?.id ?? null);
  const [content, setContent] = useState(initial?.content ?? "");
  const [savedContent, setSavedContent] = useState(initial?.content ?? "");
  const [version, setVersion] = useState(initial?.version ?? 0);
  const [status, setStatus] = useState<SaveStatus>(initial ? "saved" : "idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [failureAction, setFailureAction] = useState<"save" | "remove" | "restore" | null>(null);
  const [createOutcomeUncertain, setCreateOutcomeUncertain] = useState(false);
  const pendingCommand = useRef<PendingSave | null>(null);
  const lifecycleCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const saveOutcomeUncertain = useRef(false);
  const restoreFollowupBaseline = useRef<string | null>(null);
  const guardId = useRef(Symbol("note-editor-guard"));

  const unsettled = status === "pending" || status === "saving" || status === "failed" || status === "conflict" || status === "removal_pending";

  const save = useCallback(async (forceVersion?: number) => {
    if ((!content.trim() && !saveOutcomeUncertain.current) || status === "saving" || status === "removed") return;
    const creating = noteId === null;
    const fingerprint = JSON.stringify({ noteId, version: forceVersion ?? version, content });
    if (!saveOutcomeUncertain.current && pendingCommand.current?.fingerprint !== fingerprint) {
      pendingCommand.current = { fingerprint, commandId: crypto.randomUUID(), noteId, version: forceVersion ?? version, content };
    }
    const command = pendingCommand.current;
    if (!command) return;
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try {
      result = command.noteId
        ? await updateNote({ commandId: command.commandId, noteId: command.noteId, expectedVersion: command.version, content: command.content })
        : await createNote({ commandId: command.commandId, gameId, content: command.content });
    } catch {
      saveOutcomeUncertain.current = true;
      setFailure({ message: "無法確認筆記是否已儲存，請用相同操作重試。" });
      setFailureAction("save");
      if (creating) setCreateOutcomeUncertain(true);
      setStatus("failed");
      return;
    }
    if (!result.ok) {
      saveOutcomeUncertain.current = false;
      pendingCommand.current = null;
      setFailure({ message: result.message, currentNote: result.currentNote });
      setFailureAction("save");
      setCreateOutcomeUncertain(false);
      setStatus(result.code === "command_version_conflict" && result.currentNote ? "conflict" : "failed");
      return;
    }
    setNoteId(result.resourceId);
    setVersion(result.version);
    setSavedContent(command.content);
    pendingCommand.current = null;
    saveOutcomeUncertain.current = false;
    setFailureAction(null);
    setCreateOutcomeUncertain(false);
    setStatus(content === command.content ? "saved" : content.trim() ? "pending" : "removal_pending");
    if (creating && onCreated) {
      const now = new Date().toISOString();
      onCreated({ id: result.resourceId, gameId, content: command.content, version: result.version, state: "active", createdAt: now, updatedAt: now });
    }
  }, [content, gameId, noteId, onCreated, status, version]);

  useEffect(() => {
    const id = guardId.current;
    const editors = navigationGuardState().unsettledEditors;
    if (unsettled) editors.set(id, status === "removal_pending");
    else editors.delete(id);
    return () => { editors.delete(id); };
  }, [status, unsettled]);

  useEffect(() => {
    if (status !== "pending" || (!content.trim() && !saveOutcomeUncertain.current)) return;
    const timer = window.setTimeout(() => void save(), 600);
    return () => window.clearTimeout(timer);
  }, [content, save, status]);

  function changeText(value: string) {
    if (createOutcomeUncertain) return;
    setContent(value);
    setFailure(null);
    setFailureAction(null);
    if (!value.trim()) {
      if (saveOutcomeUncertain.current) setStatus("pending");
      else {
        pendingCommand.current = null;
        setStatus(noteId ? "removal_pending" : "idle");
      }
    } else {
      setStatus(!saveOutcomeUncertain.current && value === savedContent ? "idle" : "pending");
    }
  }

  async function remove(forceVersion?: number, forceContent?: string) {
    if (!noteId) { onDiscard?.(); return; }
    const expectedVersion = forceVersion ?? version;
    const fingerprint = `remove:${noteId}:${expectedVersion}`;
    if (lifecycleCommand.current?.fingerprint !== fingerprint) lifecycleCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try { result = await removeNote({ commandId: lifecycleCommand.current.commandId, noteId, expectedVersion }); }
    catch { setFailure({ message: "無法確認筆記是否已移除，請用相同操作重試。" }); setFailureAction("remove"); setStatus("failed"); return; }
    if (!result.ok) { setFailure({ message: result.message, currentNote: result.currentNote }); setFailureAction("remove"); setStatus(result.code === "command_version_conflict" && result.currentNote ? "conflict" : "failed"); return; }
    setVersion(result.version);
    setContent(forceContent ?? savedContent);
    if (forceContent !== undefined) setSavedContent(forceContent);
    lifecycleCommand.current = null;
    setStatus("removed");
  }

  async function restore(forceVersion?: number, restoredServerContent?: string) {
    if (!noteId) return;
    if (restoredServerContent !== undefined) restoreFollowupBaseline.current = restoredServerContent;
    const expectedVersion = forceVersion ?? version;
    const fingerprint = `restore:${noteId}:${expectedVersion}`;
    if (lifecycleCommand.current?.fingerprint !== fingerprint) lifecycleCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    setStatus("saving");
    setFailure(null);
    setFailureAction(null);
    let result;
    try { result = await restoreNote({ commandId: lifecycleCommand.current.commandId, noteId, expectedVersion }); }
    catch { setFailure({ message: "無法確認筆記是否已還原，請用相同操作重試。" }); setFailureAction("restore"); setStatus("failed"); return; }
    if (!result.ok) { setFailure({ message: result.message, currentNote: result.currentNote }); setFailureAction("restore"); setStatus(result.code === "command_version_conflict" && result.currentNote ? "conflict" : "failed"); return; }
    setVersion(result.version);
    lifecycleCommand.current = null;
    const followupBaseline = restoreFollowupBaseline.current;
    restoreFollowupBaseline.current = null;
    if (followupBaseline !== null) setSavedContent(followupBaseline);
    setStatus(followupBaseline !== null && content !== followupBaseline ? "pending" : "saved");
  }

  function retryFailure() {
    if (failureAction === "remove") return void remove();
    if (failureAction === "restore") return void restore();
    return void save();
  }

  function loadCurrentNote(current: NoteRecord) {
    setContent(current.content);
    setSavedContent(current.content);
    setVersion(current.version);
    setFailure(null);
    setFailureAction(null);
    lifecycleCommand.current = null;
    pendingCommand.current = null;
    saveOutcomeUncertain.current = false;
    restoreFollowupBaseline.current = null;
    setStatus(current.state === "removed" ? "removed" : "idle");
  }

  function retryConflict(current: NoteRecord) {
    lifecycleCommand.current = null;
    pendingCommand.current = null;
    setVersion(current.version);
    if (failureAction === "restore" && restoreFollowupBaseline.current !== null) {
      if (current.state === "active") {
        restoreFollowupBaseline.current = null;
        setSavedContent(current.content);
        return void save(current.version);
      }
      return void restore(current.version, current.content);
    }
    if ((failureAction === "remove" && current.state === "removed") || (failureAction === "restore" && current.state === "active")) {
      loadCurrentNote(current);
      return;
    }
    if (failureAction === "remove") {
      setContent(current.content);
      setSavedContent(current.content);
      return void remove(current.version, current.content);
    }
    if (failureAction === "restore") {
      setContent(current.content);
      setSavedContent(current.content);
      return void restore(current.version);
    }
    if (current.state === "removed") {
      setSavedContent(current.content);
      return void restore(current.version, current.content);
    }
    return void save(current.version);
  }

  if (status === "removed") return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm"><p>筆記已移除，原文仍安全保留。</p><button type="button" onClick={() => void restore()} className="mt-3 min-h-11 rounded-xl bg-amber-900 px-4 font-semibold text-white">立即復原</button></div>;

  const label = status === "saving" ? "儲存中……" : status === "saved" ? "已儲存" : status === "failed" ? "儲存失敗" : status === "conflict" ? "版本衝突" : status === "removal_pending" ? "待確認移除" : status === "pending" && content.trim() ? "等待儲存" : "";
  return <article className="rounded-2xl border border-slate-200 bg-white p-4">
    <textarea aria-label={initial ? "編輯筆記" : "新增筆記內容"} value={content} onChange={(event) => changeText(event.target.value)} disabled={status === "saving" || createOutcomeUncertain} rows={6} placeholder="用 Markdown 記下心得……" className="w-full resize-y rounded-xl border border-slate-300 p-3 leading-7 disabled:bg-slate-50" />
    <div className="mt-2 flex min-h-6 items-center justify-between gap-3 text-sm"><span aria-live="polite" className={status === "failed" || status === "conflict" ? "font-semibold text-red-700" : "text-slate-600"}>{label}</span>{status === "failed" && <button type="button" onClick={retryFailure} className="font-semibold text-emerald-800">重試</button>}</div>
    {failure && <p className="mt-1 text-sm text-red-700">{failure.message}</p>}
    {status === "removal_pending" && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void remove()} className="min-h-11 rounded-xl bg-red-800 px-4 font-semibold text-white">確認移除</button><button type="button" onClick={() => { setContent(savedContent); setStatus("idle"); }} className="min-h-11 rounded-xl border px-4 font-semibold">保留原文</button></div>}
    {status === "conflict" && failure?.currentNote && <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm"><p className="font-semibold">伺服器版本</p><p className="mt-1 whitespace-pre-wrap">{failure.currentNote.content}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => loadCurrentNote(failure.currentNote!)} className="min-h-11 rounded-xl border px-3 font-semibold">載入伺服器版本</button><button type="button" onClick={() => retryConflict(failure.currentNote!)} className="min-h-11 rounded-xl bg-emerald-900 px-3 font-semibold text-white">{failureAction === "remove" ? "以最新版本確認移除" : failureAction === "restore" ? "以最新版本再次還原" : "保留我的內容並重送"}</button></div></div>}
    {!noteId && !content.trim() && <button type="button" onClick={onDiscard} className="mt-2 text-sm text-slate-600">放棄空白草稿</button>}
  </article>;
}

export function NotesClient({ gameId, initialNotes }: Readonly<{ gameId: string; initialNotes: readonly NoteRecord[] }>) {
  const [draft, setDraft] = useState(false);
  const [notes, setNotes] = useState<readonly NoteRecord[]>(initialNotes);
  useEffect(() => {
    const openDraft = () => {
      if (window.location.hash === "#notes-heading") setDraft(true);
    };
    openDraft();
    window.addEventListener("hashchange", openDraft);
    return () => window.removeEventListener("hashchange", openDraft);
  }, []);
  return <section id="notes-heading" className="mt-10" aria-labelledby="notes-title"><div className="flex items-center justify-between"><h2 id="notes-title" className="text-xl font-semibold">筆記</h2><button type="button" onClick={() => setDraft(true)} disabled={draft} className="min-h-11 rounded-xl bg-emerald-900 px-4 font-semibold text-white disabled:opacity-50">新增筆記</button></div><div className="mt-4 grid gap-4">{notes.map((note) => <NoteEditor key={note.id} gameId={gameId} initial={note} />)}{draft && <NoteEditor key="draft" gameId={gameId} onCreated={(note) => { setNotes((current) => [...current, note]); setDraft(false); }} onDiscard={() => setDraft(false)} />}{!draft && notes.length === 0 && <p className="rounded-2xl bg-white p-4 text-slate-600">尚無筆記。</p>}</div></section>;
}

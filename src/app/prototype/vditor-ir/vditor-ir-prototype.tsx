"use client";

import { useEffect, useRef, useState } from "react";
import type Vditor from "vditor";
import { canPersistDraft, classifyDraft, normalizeMarkdown, preservesMarkdown, prototypeMarkdown, type DraftState, type NoteKind } from "./prototype-state";

const draftStorageKey = "puizeru-gamebase:prototype:vditor-ir:draft";
const saveDelay = 450;

type SaveState = "idle" | "saving" | "saved" | "error";
type CompositionState = "尚未操作" | "組字中" | "組字完成";

const stateLabels: Record<DraftState | SaveState, string> = {
  clean: "內容與儲存值一致",
  dirty: "有尚未送出的變更",
  "empty-new": "空白新筆記不建立",
  "pending-removal": "清空後待確認移除",
  idle: "等待輸入",
  saving: "正在儲存……",
  saved: "已儲存至原型草稿",
  error: "儲存失敗，文字仍保留",
};

export function VditorIrPrototype() {
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Vditor | null>(null);
  const editorReadyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveCompletionRef = useRef<number | null>(null);
  const savedContentRef = useRef(prototypeMarkdown);
  const currentContentRef = useRef(prototypeMarkdown);
  const noteKindRef = useRef<NoteKind>("existing");
  const saveFailureRef = useRef(false);
  const [noteKind, setNoteKind] = useState<NoteKind>("existing");
  const [currentContent, setCurrentContent] = useState(prototypeMarkdown);
  const [draftState, setDraftState] = useState<DraftState>("clean");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveFailure, setSaveFailure] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [exportedMarkdown, setExportedMarkdown] = useState("");
  const [roundTripResult, setRoundTripResult] = useState<"未檢查" | "保留一致" | "內容有差異">("未檢查");
  const [compositionState, setCompositionState] = useState<CompositionState>("尚未操作");
  const [inputEvents, setInputEvents] = useState(0);
  const [lastInputType, setLastInputType] = useState("尚未輸入");

  function clearSaveTimers() {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (saveCompletionRef.current !== null) window.clearTimeout(saveCompletionRef.current);
    saveTimerRef.current = null;
    saveCompletionRef.current = null;
  }

  function setEditorContent(value: string) {
    currentContentRef.current = value;
    setCurrentContent(value);
    if (editorReadyRef.current) editorRef.current?.setValue(value);
    setDraftState(classifyDraft(noteKindRef.current, value, savedContentRef.current));
    setSaveState("idle");
    setExportedMarkdown("");
    setRoundTripResult("未檢查");
  }

  function persistDraft(value: string) {
    const kind = noteKindRef.current;
    if (!canPersistDraft(kind, value)) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    saveCompletionRef.current = window.setTimeout(() => {
      if (saveFailureRef.current) {
        setSaveState("error");
        return;
      }
      window.localStorage.setItem(draftStorageKey, JSON.stringify({ content: value, kind }));
      savedContentRef.current = value;
      setDraftState("clean");
      setSaveState("saved");
    }, 260);
  }

  function queuePersist(value: string) {
    clearSaveTimers();
    const nextState = classifyDraft(noteKindRef.current, value, savedContentRef.current);
    setDraftState(nextState);
    if (!canPersistDraft(noteKindRef.current, value)) {
      setSaveState("idle");
      return;
    }
    setSaveState("idle");
    saveTimerRef.current = window.setTimeout(() => persistDraft(value), saveDelay);
  }

  function handleInput(value: string, inputType = "input") {
    currentContentRef.current = value;
    setCurrentContent(value);
    setInputEvents((count) => count + 1);
    setLastInputType(inputType);
    queuePersist(value);
  }

  function exportMarkdown() {
    const value = editorRef.current?.getValue() ?? currentContentRef.current;
    setExportedMarkdown(value);
    setRoundTripResult(preservesMarkdown(currentContentRef.current, value) ? "保留一致" : "內容有差異");
  }

  function changeNoteKind(nextKind: NoteKind) {
    clearSaveTimers();
    noteKindRef.current = nextKind;
    setNoteKind(nextKind);
    const value = currentContentRef.current;
    setDraftState(classifyDraft(nextKind, value, savedContentRef.current));
    setSaveState("idle");
  }

  function clearNote() {
    clearSaveTimers();
    setEditorContent("");
  }

  function restoreNote() {
    clearSaveTimers();
    setEditorContent(savedContentRef.current || prototypeMarkdown);
  }

  function retrySave() {
    queuePersist(currentContentRef.current);
  }

  useEffect(() => {
    let disposed = false;
    let editor: Vditor | null = null;
    const host = editorHostRef.current;
    if (!host) return;

    const onCompositionStart = () => setCompositionState("組字中");
    const onCompositionEnd = () => setCompositionState("組字完成");
    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      setLastInputType(inputEvent.inputType || "input");
    };
    host.addEventListener("compositionstart", onCompositionStart, true);
    host.addEventListener("compositionend", onCompositionEnd, true);
    host.addEventListener("input", onInput, true);

    void import("vditor").then(({ default: Vditor }) => {
      if (disposed) return;
      const stored = window.localStorage.getItem(draftStorageKey);
      let initialValue = prototypeMarkdown;
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { content?: unknown; kind?: unknown };
          if (typeof parsed.content === "string") initialValue = parsed.content;
          if (parsed.kind === "new" || parsed.kind === "existing") {
            noteKindRef.current = parsed.kind;
            setNoteKind(parsed.kind);
          }
        } catch {
          window.localStorage.removeItem(draftStorageKey);
        }
      }
      currentContentRef.current = initialValue;
      setCurrentContent(initialValue);
      savedContentRef.current = initialValue;
      editor = new Vditor(host, {
        mode: "ir",
        lang: "zh_TW",
        value: initialValue,
        cache: { enable: false },
        height: "auto",
        minHeight: 410,
        placeholder: "輸入一段筆記……",
        toolbarConfig: { pin: true },
        toolbar: ["headings", "bold", "italic", "link", "|", "list", "ordered-list", "check", "|", "quote", "code", "inline-code", "undo", "redo", "fullscreen"],
        input: (value) => handleInput(value),
        after: () => {
          editorReadyRef.current = true;
          setIsReady(true);
        },
      });
      editorRef.current = editor;
      setDraftState("clean");
    }).catch(() => setSaveState("error"));

    return () => {
      disposed = true;
      clearSaveTimers();
      host.removeEventListener("compositionstart", onCompositionStart, true);
      host.removeEventListener("compositionend", onCompositionEnd, true);
      host.removeEventListener("input", onInput, true);
      editorReadyRef.current = false;
      editor?.destroy();
      editorRef.current = null;
    };
    // Vditor is initialized once; handlers only close over refs and stable React setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusKey = draftState === "dirty" && saveState === "idle"
    ? "dirty"
    : draftState === "clean" && saveState === "idle"
      ? "clean"
      : draftState === "dirty" || draftState === "clean"
        ? saveState
        : draftState;
  const displayState = stateLabels[statusKey];
  const hasContent = normalizeMarkdown(currentContent) !== "";

  return (
    <>
      <section className="prototype-panel prototype-panel--editor" aria-labelledby="editor-title">
        <div className="prototype-panel__header">
          <div>
            <h2 id="editor-title">Vditor ir：即時渲染編輯區</h2>
            <p>工具列設定為固定；點進標題、斜體或連結後觀察語法標記是否能回到可編輯狀態。</p>
          </div>
          <span className="prototype-note-chip">隔離原型</span>
        </div>
        <div className="prototype-editor" ref={editorHostRef} data-testid="vditor-host" />
        <div className="prototype-editor__footer">
          <p className="prototype-save-state" data-state={statusKey} role="status" data-testid="save-status">{isReady ? displayState : "正在載入編輯器……"}</p>
          {saveState === "error" && <button className="prototype-button prototype-button--quiet" type="button" onClick={retrySave}>重試儲存</button>}
        </div>
        <div className="prototype-toolbar" aria-label="原型操作">
          <button className="prototype-button" type="button" onClick={exportMarkdown}>取得 Markdown</button>
          <button className="prototype-button prototype-button--quiet" type="button" onClick={clearNote}>清空目前內容</button>
          <button className="prototype-button prototype-button--quiet" type="button" onClick={restoreNote}>還原儲存值</button>
        </div>
      </section>

      <div className="prototype-grid">
        <section className="prototype-panel prototype-card" aria-labelledby="roundtrip-title">
          <h2 id="roundtrip-title">Markdown 往返與狀態相容</h2>
          <p className="prototype-card__intro">原型只把 Markdown 純文字交給儲存適配器；Vditor 的 HTML 是編輯呈現層，不是資料來源。</p>
          <p className="prototype-result">往返檢查：<strong data-testid="roundtrip-result">{roundTripResult}</strong></p>
          <p className="prototype-result">目前模式：<strong>{noteKind === "existing" ? "既有筆記" : "新筆記"}</strong>；目前內容：<strong>{hasContent ? "非空白" : "空白"}</strong></p>
          {exportedMarkdown ? <pre className="prototype-raw" data-testid="markdown-export">{exportedMarkdown}</pre> : <p className="prototype-raw prototype-raw--empty">按下「取得 Markdown」後，這裡會顯示 Vditor.getValue() 的原文。</p>}
        </section>

        <section className="prototype-panel prototype-card" aria-labelledby="events-title">
          <h2 id="events-title">輸入事件觀察</h2>
          <p className="prototype-card__intro">自動化只確認事件路徑存在；真實注音組字仍標為人工驗證。</p>
          <div className="prototype-event-grid">
            <div className="prototype-event"><span className="prototype-event__label">Composition</span><strong data-testid="composition-state">{compositionState}</strong></div>
            <div className="prototype-event"><span className="prototype-event__label">Input 次數</span><strong data-testid="input-count">{inputEvents}</strong></div>
            <div className="prototype-event"><span className="prototype-event__label">最後類型</span><strong data-testid="last-input-type">{lastInputType}</strong></div>
            <div className="prototype-event"><span className="prototype-event__label">工具列</span><strong>固定</strong></div>
          </div>
          <label className="prototype-toggle prototype-spaced">
            <input type="checkbox" checked={saveFailure} onChange={(event) => { setSaveFailure(event.target.checked); saveFailureRef.current = event.target.checked; }} />
            <span>模擬下一次儲存失敗（確認文字不會回復舊值）</span>
          </label>
          <div className="prototype-actions prototype-spaced">
            <button className="prototype-button prototype-button--quiet" type="button" onClick={() => changeNoteKind("existing")}>以既有筆記驗證清空待確認</button>
            <button className="prototype-button prototype-button--quiet" type="button" onClick={() => changeNoteKind("new")}>以新筆記驗證空白不建立</button>
          </div>
        </section>
      </div>

      {exportedMarkdown && <section className="prototype-panel prototype-card" aria-labelledby="manual-title">
        <h2 id="manual-title">390px 驗證清單</h2>
        <ul className="prototype-checklist">
          <li><span>語法揭露：點進 `#` 標題、`*` 斜體與連結，確認標記出現且可以直接調整。</span></li>
          <li><span>固定工具列：向下捲動編輯內容，確認工具列仍在編輯區頂端並可觸控。</span></li>
          <li><span>Markdown 往返：按「取得 Markdown」，確認原文仍包含標題、清單、連結與核取方塊。</span></li>
          <li data-result="manual"><span>繁中 IME：使用真實注音鍵盤輸入、選字、刪除與重新載入；本頁自動化不宣稱此項通過。</span></li>
          <li data-result="manual"><span>離線流程：開啟失敗模擬後輸入，確認顯示失敗、文字保留，再關閉模擬並按重試。</span></li>
        </ul>
        <div className="prototype-manual"><strong>未決：</strong>只有在真實手機完成繁中注音組字與虛擬鍵盤遮擋檢查後，才能裁決是否取代 MVP 的 Markdown 原始碼編輯器。</div>
      </section>}
    </>
  );
}

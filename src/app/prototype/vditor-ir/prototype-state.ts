export type NoteKind = "new" | "existing";

export type DraftState = "clean" | "dirty" | "empty-new" | "pending-removal";

export const prototypeDraftStorageKey = "puizeru-gamebase:prototype:vditor-ir:draft";

export type PrototypeDraft = { content: string; kind: NoteKind };
type PrototypeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function classifyDraft(kind: NoteKind, content: string, savedContent: string): DraftState {
  if (normalizeMarkdown(content) === "") return kind === "new" ? "empty-new" : "pending-removal";
  return normalizeMarkdown(content) === normalizeMarkdown(savedContent) ? "clean" : "dirty";
}

export function canPersistDraft(kind: NoteKind, content: string): boolean {
  return kind === "existing" || normalizeMarkdown(content) !== "";
}

export function preservesMarkdown(original: string, exported: string): boolean {
  return normalizeMarkdown(original) === normalizeMarkdown(exported);
}

export function readPrototypeDraft(storage: PrototypeStorage, key = prototypeDraftStorageKey): StorageResult<PrototypeDraft | null> {
  try {
    const stored = storage.getItem(key);
    if (!stored) return { ok: true, value: null };

    const parsed = JSON.parse(stored) as { content?: unknown; kind?: unknown };
    if (typeof parsed.content !== "string" || (parsed.kind !== "new" && parsed.kind !== "existing")) {
      return removePrototypeDraft(storage, key);
    }
    return { ok: true, value: { content: parsed.content, kind: parsed.kind } };
  } catch (error) {
    return { ok: false, error };
  }
}

export function writePrototypeDraft(storage: PrototypeStorage, draft: PrototypeDraft, key = prototypeDraftStorageKey): StorageResult<void> {
  try {
    storage.setItem(key, JSON.stringify(draft));
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error };
  }
}

export function removePrototypeDraft(storage: PrototypeStorage, key = prototypeDraftStorageKey): StorageResult<null> {
  try {
    storage.removeItem(key);
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, error };
  }
}

export const prototypeMarkdown = `# 海邊電台：第一次遊玩

這是一則代表性筆記：保留 *斜體*、**粗體**、[外部連結](https://example.com) 與清單語法。

- 先觀察每個人的起始資源

- [ ]  記下第一輪的節奏
- [X]  回合結束後整理感想

> 手機上要能看見內容變化，也要能回到 Markdown 原文。

~~~text
保留未裁決的細節，不把原文交給另一種格式。
~~~

%% VDITOR_IR_UNSUPPORTED_MARKER: keep-this-line %%
`;

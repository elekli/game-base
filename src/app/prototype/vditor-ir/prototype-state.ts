export type NoteKind = "new" | "existing";

export type DraftState = "clean" | "dirty" | "empty-new" | "pending-removal";

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

export const prototypeMarkdown = `# 海邊電台：第一次遊玩

這是一則代表性筆記：保留 *斜體*、**粗體**、[外部連結](https://example.com) 與清單語法。

- 先觀察每個人的起始資源
- [ ] 記下第一輪的節奏
- [x] 回合結束後整理感想

> 手機上要能看見內容變化，也要能回到 Markdown 原文。

~~~text
保留未裁決的細節，不把原文交給另一種格式。
~~~`;

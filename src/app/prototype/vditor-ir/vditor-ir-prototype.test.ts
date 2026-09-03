import { describe, expect, it } from "vitest";
import { canPersistDraft, classifyDraft, normalizeMarkdown, preservesMarkdown, prototypeMarkdown, readPrototypeDraft, removePrototypeDraft, writePrototypeDraft } from "./prototype-state";

describe("Vditor ir prototype state adapter", () => {
  it("keeps Markdown as the comparison and persistence format", () => {
    const markdown = "# 標題\r\n\r\n- 項目\r\n";
    expect(normalizeMarkdown(markdown)).toBe("# 標題\n\n- 項目");
    expect(preservesMarkdown(markdown, "# 標題\n\n- 項目")).toBe(true);
    expect(preservesMarkdown(markdown, "# 標題\n\n項目")).toBe(false);
  });

  it("keeps supported syntax and an unsupported marker in the independent fixture", () => {
    expect(prototypeMarkdown).toContain("# 海邊電台：第一次遊玩");
    expect(prototypeMarkdown).toContain("*斜體*");
    expect(prototypeMarkdown).toContain("**粗體**");
    expect(prototypeMarkdown).toContain("[外部連結](https://example.com)");
    expect(prototypeMarkdown).toContain("- [X]  回合結束後整理感想");
    expect(prototypeMarkdown).toContain("%% VDITOR_IR_UNSUPPORTED_MARKER: keep-this-line %%");
    expect(preservesMarkdown(prototypeMarkdown, prototypeMarkdown)).toBe(true);
    expect(preservesMarkdown(prototypeMarkdown, prototypeMarkdown.replace("keep-this-line", "marker-was-lost"))).toBe(false);
  });

  it("does not persist a blank new note", () => {
    expect(classifyDraft("new", "  \n", "")).toBe("empty-new");
    expect(canPersistDraft("new", "  \n")).toBe(false);
  });

  it("keeps the saved value while an existing note awaits removal", () => {
    expect(classifyDraft("existing", "\n\t", "原本的內容")).toBe("pending-removal");
    expect(canPersistDraft("existing", "\n\t")).toBe(true);
  });

  it("distinguishes a changed draft from a clean saved note", () => {
    expect(classifyDraft("existing", "原本的內容", "原本的內容\n")).toBe("clean");
    expect(classifyDraft("existing", "修改後的內容", "原本的內容")).toBe("dirty");
  });

  it("keeps the old value while an existing note is blank, then permits a non-empty save", () => {
    const oldValue = "原本的內容";
    expect(classifyDraft("existing", "\n", oldValue)).toBe("pending-removal");
    expect(classifyDraft("existing", oldValue, oldValue)).toBe("clean");
    expect(classifyDraft("existing", `${oldValue}\n恢復後的內容`, oldValue)).toBe("dirty");
    expect(canPersistDraft("existing", `${oldValue}\n恢復後的內容`)).toBe(true);
  });

  it("turns storage exceptions into inspectable results", () => {
    const throwingStorage = {
      getItem: () => { throw new Error("get failed"); },
      setItem: () => { throw new Error("set failed"); },
      removeItem: () => { throw new Error("remove failed"); },
    };
    expect(readPrototypeDraft(throwingStorage).ok).toBe(false);
    expect(writePrototypeDraft(throwingStorage, { content: "內容", kind: "existing" }).ok).toBe(false);
    expect(removePrototypeDraft(throwingStorage).ok).toBe(false);
  });
});

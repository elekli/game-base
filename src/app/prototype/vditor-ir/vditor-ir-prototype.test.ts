import { describe, expect, it } from "vitest";
import { canPersistDraft, classifyDraft, normalizeMarkdown, preservesMarkdown } from "./prototype-state";

describe("Vditor ir prototype state adapter", () => {
  it("keeps Markdown as the comparison and persistence format", () => {
    const markdown = "# 標題\r\n\r\n- 項目\r\n";
    expect(normalizeMarkdown(markdown)).toBe("# 標題\n\n- 項目");
    expect(preservesMarkdown(markdown, "# 標題\n\n- 項目")).toBe(true);
    expect(preservesMarkdown(markdown, "# 標題\n\n項目")).toBe(false);
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
});

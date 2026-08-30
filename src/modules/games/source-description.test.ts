import { describe, expect, it } from "vitest";
import { sanitizeSourceDescription } from "./internal/source-description";

describe("來源介紹清理", () => {
  it("移除 HTML、script 與 style，不執行來源內容", () => {
    expect(sanitizeSourceDescription("<p>安全介紹</p><script>alert(1)</script><style>p{display:none}</style>")).toBe("安全介紹");
  });
});

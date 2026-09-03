import { describe, expect, it } from "vitest";
import { sanitizeSourceDescription } from "./internal/source-description";

describe("來源介紹清理", () => {
  it("移除 HTML、script 與 style，不執行來源內容", () => {
    expect(sanitizeSourceDescription("<p>安全介紹</p><script>alert(1)</script><style>p{display:none}</style>")).toBe("安全介紹");
  });
  it("解碼後的 entity 仍以純文字顯示並移除 script 標籤", () => {
    expect(sanitizeSourceDescription("A & B <script>alert(1)</script>")).toBe("A & B");
  });
});

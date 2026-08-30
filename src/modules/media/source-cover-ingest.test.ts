import { describe, expect, it } from "vitest";
import { isAllowedSourceCoverUrl } from "./internal/source-cover-policy";

describe("來源封面匯入", () => {
  it("只接受允許的 HTTPS 主機並產生 UUID", () => {
    expect(isAllowedSourceCoverUrl("https://cf.geekdo-images.com/a.jpg")).toBe(true);
    expect(isAllowedSourceCoverUrl("http://cf.geekdo-images.com/a.jpg")).toBe(false);
    expect(isAllowedSourceCoverUrl("https://evil.example/a.jpg")).toBe(false);
  });
});

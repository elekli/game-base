import { describe, expect, it } from "vitest";
import { isAllowedSourceCoverUrl } from "./internal/source-cover-policy";
import { beginSourceCoverIngest } from "./internal/source-cover-ingest";

describe("來源封面匯入", () => {
  it("只接受允許的 HTTPS 主機並產生 UUID", () => {
    expect(isAllowedSourceCoverUrl("https://cf.geekdo-images.com/a.jpg")).toBe(true);
    expect(isAllowedSourceCoverUrl("http://cf.geekdo-images.com/a.jpg")).toBe(false);
    expect(isAllowedSourceCoverUrl("https://evil.example/a.jpg")).toBe(false);
  });

  it("同一來源操作重用 key 與 path，後續 refresh 使用新 key", () => {
    const gameId = "10000000-0000-4000-8000-000000000001";
    const identityId = "20000000-0000-4000-8000-000000000001";
    const url = "https://cf.geekdo-images.com/a.jpg";
    const first = beginSourceCoverIngest("operation-1", gameId, identityId, url);
    const retry = beginSourceCoverIngest("operation-1", gameId, identityId, url);
    const retryAfterSourceChanged = beginSourceCoverIngest("operation-1", gameId, identityId, "https://cf.geekdo-images.com/changed.jpg");
    const laterRefresh = beginSourceCoverIngest("operation-2", gameId, identityId, url);

    expect(retry).toEqual(first);
    expect(retryAfterSourceChanged.idempotencyKey).toBe(first.idempotencyKey);
    expect(retryAfterSourceChanged.objectKey).toBe(first.objectKey);
    expect(laterRefresh.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(laterRefresh.objectKey).not.toBe(first.objectKey);
    expect(first.externalGameIdentityId).toBe(identityId);
  });
});

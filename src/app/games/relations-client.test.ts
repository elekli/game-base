import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/private-relation-actions", () => ({
  addGameRelation: vi.fn(), describeGameRelation: vi.fn(), removeGameRelation: vi.fn(),
  restoreGameRelation: vi.fn(), searchRelationTargets: vi.fn(),
}));
vi.mock("@/app/private-list-actions", () => ({ retryExternalListThumbnail: vi.fn() }));

import { RelationsClient } from "./[gameId]/relations-client";

describe("RelationsClient 縮圖重試", () => {
  it("missing 狀態明示尚未保存並提供檢查入口", () => {
    const html = renderToStaticMarkup(createElement(RelationsClient, {
      gameId: "11111111-1111-4111-8111-111111111111",
      libraryGames: [],
      initialRelations: [{
        id: "22222222-2222-4222-8222-222222222222", version: 1,
        left: { kind: "game", gameId: "11111111-1111-4111-8111-111111111111" },
        right: { kind: "external", ref: { provider: "bgg", medium: "board_game", sourceId: "13" }, name: "Catan", releaseYear: 1995, thumbnailState: "missing" },
        leftGameId: "11111111-1111-4111-8111-111111111111", rightGameId: null,
        leftTrashed: false, rightTrashed: false, description: null, removed: false,
      }],
    }));

    expect(html).toContain("封面縮圖尚未保存；可重新檢查。");
    expect(html).toContain("檢查封面縮圖");
  });
});

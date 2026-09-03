import { describe, expect, it } from "vitest";
import { buildLibrarySearchParams, parseLibrarySearchParams } from "./library-search-params";

describe("收藏庫篩選參數", () => {
  it("多媒介解析時清除分類、重度與 BGG 排序", () => {
    expect(parseLibrarySearchParams({ medium: ["board_game", "video_game"], category: "category:1", weightMin: "2", sort: "strategy_rank" })).toEqual({
      media: ["board_game", "video_game"], sourceCategories: [], weightMin: undefined, weightMax: undefined, sort: "name",
    });
  });

  it("多媒介表單送出時不產生不相容的 URL 參數", () => {
    const form = new FormData();
    form.append("medium", "board_game");
    form.append("medium", "video_game");
    form.append("category", "category:1");
    form.append("sort", "strategy_rank");
    form.append("weightMin", "2");
    expect(buildLibrarySearchParams(form).toString()).toBe("medium=board_game&medium=video_game&sort=name");
  });
});

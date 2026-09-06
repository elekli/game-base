import { describe, expect, it } from "vitest";
import { buildLibrarySearchParams, parseLibrarySearchParams, parseLibraryUrlSearchParams } from "./library-search-params";

describe("收藏庫篩選參數", () => {
  it("保留名稱、實際平台與自由標籤多選 URL 狀態，並忽略空條件", () => {
    const form = new FormData();
    form.set("search", "  Zelda  ");
    form.append("platform", "Steam");
    form.append("platform", "Nintendo Switch");
    form.append("tag", "劇情向");
    form.set("sort", "name");

    expect(buildLibrarySearchParams(form).toString()).toBe("search=Zelda&platform=Steam&platform=Nintendo+Switch&tag=%E5%8A%87%E6%83%85%E5%90%91&sort=name");
    expect(parseLibrarySearchParams({ search: " Zelda ", platform: ["Steam", "Nintendo Switch"], tag: "劇情向" })).toMatchObject({
      search: "Zelda",
      actualPlatforms: ["Steam", "Nintendo Switch"],
      tags: ["劇情向"],
    });
    expect(parseLibrarySearchParams({ search: " ", platform: "", tag: ["", " "] })).toMatchObject({
      search: undefined,
      actualPlatforms: [],
      tags: [],
    });
  });

  it("多媒介解析時清除分類、重度與 BGG 排序", () => {
    expect(parseLibrarySearchParams({ medium: ["board_game", "video_game"], category: "category:1", weightMin: "2", sort: "strategy_rank" })).toEqual({
      search: undefined, media: ["board_game", "video_game"], actualPlatforms: [], tags: [], sourceCategories: [], weightMin: undefined, weightMax: undefined, sort: "name",
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

  it("解析瀏覽器歷史 URL 時保留重複條件", () => {
    expect(parseLibraryUrlSearchParams(new URLSearchParams("search=Zelda&platform=Steam&platform=Switch"))).toMatchObject({
      search: "Zelda",
      actualPlatforms: ["Steam", "Switch"],
    });
  });
});

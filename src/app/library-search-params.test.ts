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
      search: undefined, media: ["board_game", "video_game"], actualPlatforms: [], tags: [], contributorIds: [], contributorRoles: [], sourceCategories: [], weightMin: undefined, weightMax: undefined, sort: "name",
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
    expect(parseLibraryUrlSearchParams(new URLSearchParams("search=Zelda&platform=Steam&platform=Switch&contributor=11111111-1111-4111-8111-111111111111"))).toMatchObject({
      search: "Zelda",
      actualPlatforms: ["Steam", "Switch"],
      contributorIds: ["11111111-1111-4111-8111-111111111111"],
    });
  });

  it("表單保留本地 contributor UUID，並忽略非 UUID 查詢值", () => {
    const form = new FormData();
    form.append("contributor", "11111111-1111-4111-8111-111111111111");
    form.append("contributor", "not-a-local-id");
    form.set("sort", "name");

    expect(buildLibrarySearchParams(form).toString()).toBe("contributor=11111111-1111-4111-8111-111111111111&sort=name");
    expect(parseLibrarySearchParams({ contributor: ["11111111-1111-4111-8111-111111111111", "not-a-local-id"] }).contributorIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("完整保存三種貢獻分類，同分類去重且空分類不增加條件", () => {
    const form = new FormData();
    form.append("contributor-design", "11111111-1111-4111-8111-111111111111");
    form.append("contributor-design", "22222222-2222-4222-8222-222222222222");
    form.append("contributor-design", "11111111-1111-4111-8111-111111111111");
    form.append("contributor-art", "33333333-3333-4333-8333-333333333333");
    form.append("contributor-publisher", "not-a-local-id");
    form.set("sort", "recent");

    const params = buildLibrarySearchParams(form);
    expect(params.toString()).toBe("contributor-design=11111111-1111-4111-8111-111111111111&contributor-design=22222222-2222-4222-8222-222222222222&contributor-art=33333333-3333-4333-8333-333333333333&sort=recent");
    expect(parseLibraryUrlSearchParams(params)).toMatchObject({
      contributorRoles: [
        { role: "design", contributorIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] },
        { role: "art", contributorIds: ["33333333-3333-4333-8333-333333333333"] },
      ],
    });
    expect(parseLibrarySearchParams({ "contributor-design": [], "contributor-art": [] }).contributorRoles).toEqual([]);
  });
});

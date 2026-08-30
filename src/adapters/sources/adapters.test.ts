import { describe, expect, it } from "vitest";
import { parseBggSearchXml, parseBggThingXml } from "./bgg";
import { parseIgdbGamesJson, parseIgdbSnapshot } from "./igdb";
import { validateSnapshot } from "@/modules/games";
import { SourceResponseInvalidError } from "@/modules/games/internal/errors";

describe("source adapter contracts", () => {
  it("解析 BGG XML 並保留來源身分", () => {
    const result = parseBggSearchXml('<items><item id="001"><name value="Barrage"/><yearpublished value="2019"/></item></items>');
    expect(result[0].ref).toEqual({ provider: "bgg", medium: "board_game", sourceId: "1" });
    expect(result[0].title).toBe("Barrage");
  });
  it("拒絕沒有標題的 BGG snapshot", () => {
    expect(() => parseBggThingXml("<items><item /></items>", "1")).toThrow(SourceResponseInvalidError);
  });
  it("解析 BGG primary name 與 image 元素", () => {
    const snapshot = parseBggThingXml('<item><name value="別名" type="alternate"/><name value="正式名稱" type="primary"/><image>https://cf.geekdo-images.com/cover.jpg</image><yearpublished value="2020"/></item>', "9");
    expect(snapshot.title).toBe("正式名稱");
    expect(snapshot.coverUrl).toBe("https://cf.geekdo-images.com/cover.jpg");
  });
  it("解析 IGDB JSON，protocol-relative cover 轉為 HTTPS", () => {
    const result = parseIgdbGamesJson([{ id: 7, name: "Barrage", cover: { url: "//images.igdb.com/igdb/image/upload/t_cover_big/x.jpg" } }]);
    expect(result[0].ref.provider).toBe("igdb");
    expect(result[0].coverPreviewUrl).toMatch(/^https:/);
  });
  it("拒絕 malformed IGDB payload", () => {
    expect(() => parseIgdbGamesJson([{ id: "7", name: "bad" }])).toThrow(SourceResponseInvalidError);
  });
  it("BGG 只匯入白名單分類、貢獻者與指標", () => {
    const snapshot = parseBggThingXml('<item><name value="合作遊戲" type="primary"/><name value="Co-op" type="alternate"/><link type="boardgamecategory" id="1" value="冒險"/><link type="boardgamemechanic" id="2" value="合作"/><link type="unknown" id="3" value="不應匯入"/><link type="boardgamedesigner" id="4" value="設計者"/><link type="boardgamepublisher" id="5" value="出版社"/><averageweight value="3.45"/><rank type="strategygames" rank="88"/></item>', "9");
    expect(snapshot.categories).toEqual([{ kind: "category", sourceCategoryId: "1", name: "冒險" }, { kind: "mechanic", sourceCategoryId: "2", name: "合作" }]);
    expect(snapshot.contributors.map((item) => [item.name, item.role])).toEqual([["設計者", "design"], ["出版社", "publisher"]]);
    expect(snapshot.weight).toBe(3.45);
    expect(snapshot.strategyRank).toBe(88);
    expect(snapshot.aliases).toEqual(["Co-op"]);
  });
  it("IGDB 匯入固定分類與開發／發行公司，不匯入關鍵字", () => {
    const snapshot = parseIgdbSnapshot({ id: 7, name: "Barrage", genres: [{ id: 1, name: "策略" }], themes: [{ id: 2, name: "奇幻" }], game_modes: [{ id: 3, name: "單人" }], player_perspectives: [{ id: 4, name: "第三人稱" }], keywords: [{ id: 5, name: "keyword" }], involved_companies: [{ company: { id: 9, name: "開發公司" }, developer: true }, { company: { id: 10, name: "發行公司" }, publisher: true }] }, "7");
    expect(snapshot.categories.map((item) => item.kind)).toEqual(["genre", "theme", "game_mode", "player_perspective"]);
    expect(snapshot.contributors.map((item) => [item.name, item.role])).toEqual([["開發公司", "developer"], ["發行公司", "publisher"]]);
    const dualRole = parseIgdbSnapshot({ id: 8, name: "雙重角色", involved_companies: [{ company: { id: 11, name: "同一公司" }, developer: true, publisher: true }] }, "8");
    expect(dualRole.contributors.map((item) => item.role)).toEqual(["developer", "publisher"]);
    expect(validateSnapshot({ ...dualRole, categories: [...dualRole.categories, { kind: "category", sourceCategoryId: "99", name: "不應出現" }] }).categories.map((item) => item.kind)).not.toContain("category");
  });
});

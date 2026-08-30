import { describe, expect, it } from "vitest";
import { parseBggSearchXml, parseBggThingXml } from "./bgg";
import { parseIgdbGamesJson } from "./igdb";
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
});

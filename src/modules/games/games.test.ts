import { describe, expect, it } from "vitest";
import { createGamesService } from ".";
import { SourceContentChangedError } from "./internal/errors";
import { InMemoryGameStore } from "./internal/store";
import { TestCatalogAdapter, sampleFixture } from "@/adapters/sources/test-catalog-adapter";

describe("games service", () => {
  function setup() {
    const bgg = new TestCatalogAdapter("bgg", [sampleFixture("bgg", "1", "同名遊戲")]);
    const igdb = new TestCatalogAdapter("igdb", [sampleFixture("igdb", "2", "同名遊戲")]);
    const store = new InMemoryGameStore();
    return { service: createGamesService({ bgg, igdb }, store), bgg, igdb, store };
  }

  it("搜尋同時查詢兩來源，單一來源失敗不阻礙另一來源", async () => {
    const { service, bgg } = setup();
    bgg.setScenario("unavailable");
    const result = await service.searchExternalGames({ query: "同名" });
    expect(result.groups.find((group) => group.provider === "bgg")?.errorCode).toBe("source_unavailable");
    expect(result.groups.find((group) => group.provider === "igdb")?.items).toHaveLength(1);
  });

  it("fresh fingerprint 改變時零寫入", async () => {
    const { service, bgg, store } = setup();
    const confirmation = await service.getExternalGameConfirmation({ ref: { provider: "bgg", medium: "board_game", sourceId: "1" } });
    bgg.setSnapshot({ ...confirmation.snapshot, title: "更新後名稱" });
    await expect(service.createGameFromExternalSource({ ref: confirmation.candidate.ref, confirmationFingerprint: confirmation.fingerprint })).rejects.toBeInstanceOf(SourceContentChangedError);
    expect(await store.list()).toHaveLength(0);
  });

  it("同一來源並行建立只產生一筆，名稱相同的另一來源仍可建立", async () => {
    const { service, store } = setup();
    const bggRef = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const igdbRef = { provider: "igdb" as const, medium: "video_game" as const, sourceId: "2" };
    const bggConfirmation = await service.getExternalGameConfirmation({ ref: bggRef });
    const [first, second] = await Promise.all([service.createGameFromExternalSource({ ref: bggRef, confirmationFingerprint: bggConfirmation.fingerprint }), service.createGameFromExternalSource({ ref: bggRef, confirmationFingerprint: bggConfirmation.fingerprint })]);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    const igdbConfirmation = await service.getExternalGameConfirmation({ ref: igdbRef });
    await service.createGameFromExternalSource({ ref: igdbRef, confirmationFingerprint: igdbConfirmation.fingerprint });
    expect(await store.list()).toHaveLength(2);
  });

  it("資源回收項目仍占用來源身分", async () => {
    const { service, store } = setup();
    const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const confirmation = await service.getExternalGameConfirmation({ ref });
    const created = await service.createGameFromExternalSource({ ref, confirmationFingerprint: confirmation.fingerprint });
    await store.trash(created.game.id);
    const again = await service.createGameFromExternalSource({ ref, confirmationFingerprint: confirmation.fingerprint });
    expect(again.created).toBe(false);
    expect(again.identityConflict).toBe("trashed");
  });
});

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

  it("手動條目首次連結保留自訂資料與手動貢獻", async () => {
    const { service, store } = setup();
    const manual = await service.createManualGame({ displayName: "我的名稱", medium: "board_game" });
    const withManual = (await store.addManualContribution({ gameId: manual.id, name: "我的作者", entityKind: "person", role: "design" })).game;
    const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const confirmation = await service.getExternalGameConfirmation({ ref });
    const linked = await service.linkExternalSource({ gameId: manual.id, ref, confirmationFingerprint: confirmation.fingerprint });
    expect(linked.displayName).toBe("我的名稱");
    expect(linked.snapshot?.title).toBe("同名遊戲");
    expect(linked.contributors.filter((item) => item.origin === "manual").map((item) => item.name)).toEqual(["我的作者"]);
    expect(withManual.contributors).toHaveLength(1);
  });

  it("來源刷新替換來源資料但保留名稱、標籤與手動貢獻", async () => {
    const { service, bgg, store } = setup();
    const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const confirmation = await service.getExternalGameConfirmation({ ref });
    const created = await service.createGameFromExternalSource({ ref, confirmationFingerprint: confirmation.fingerprint });
    await store.edit(created.game.id, { displayName: "收藏名稱", tags: ["合作"] });
    await store.addManualContribution({ gameId: created.game.id, name: "手動作者", entityKind: "person", role: "art" });
    bgg.setSnapshot({ ...confirmation.snapshot, title: "來源更新", aliases: ["新別名"], categories: [{ kind: "category", sourceCategoryId: "9", name: "策略" }] });
    const refreshed = await service.refreshExternalMetadata({ gameId: created.game.id });
    expect(refreshed.displayName).toBe("收藏名稱");
    expect(refreshed.sourceNames).toContain("新別名");
    expect(refreshed.tags).toEqual(["合作"]);
    expect(refreshed.contributors.filter((item) => item.origin === "manual").map((item) => item.name)).toEqual(["手動作者"]);
  });

  it("首次連結遇到內容變動或來源衝突時不寫入手動條目", async () => {
    const { service, bgg, store } = setup();
    const manual = await service.createManualGame({ displayName: "原手動名稱", medium: "board_game" });
    const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const confirmation = await service.getExternalGameConfirmation({ ref });
    bgg.setSnapshot({ ...confirmation.snapshot, title: "更新後來源名稱" });
    await expect(service.linkExternalSource({ gameId: manual.id, ref, confirmationFingerprint: confirmation.fingerprint })).rejects.toBeInstanceOf(SourceContentChangedError);
    expect((await store.get(manual.id))?.externalIdentityId).toBeNull();

    const current = await service.getExternalGameConfirmation({ ref });
    const existing = await service.createGameFromExternalSource({ ref, confirmationFingerprint: current.fingerprint });
    const secondManual = await service.createManualGame({ displayName: "第二筆手動", medium: "board_game" });
    await expect(service.linkExternalSource({ gameId: secondManual.id, ref, confirmationFingerprint: current.fingerprint })).rejects.toThrow("來源已存在");
    expect((await store.get(secondManual.id))?.externalIdentityId).toBeNull();
    expect(existing.game.externalIdentityId).not.toBeNull();
  });

  it("來源刷新抓取失敗時保留上一份快照", async () => {
    const { service, bgg, store } = setup();
    const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "1" };
    const confirmation = await service.getExternalGameConfirmation({ ref });
    const created = await service.createGameFromExternalSource({ ref, confirmationFingerprint: confirmation.fingerprint });
    bgg.setScenario("unavailable");
    await expect(service.refreshExternalMetadata({ gameId: created.game.id })).rejects.toThrow("來源暫時無法使用");
    expect((await store.get(created.game.id))?.snapshot?.title).toBe(confirmation.snapshot.title);
  });
});

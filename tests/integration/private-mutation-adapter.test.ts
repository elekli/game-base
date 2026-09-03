import { describe, expect, it, vi } from "vitest";
import { SourceIdentityConflictError } from "@/modules/games/internal/errors";
import type { ContributorMatch, GameRecord, GamesService, ManualContributionResult } from "@/modules/games";
import type { LibraryService } from "@/modules/library";
import { createPrivateMutationAdapter } from "@/app/private-mutation-adapter";
import type { PrivateActionDependencies } from "@/shared/auth/private-action";

const gameId = "11111111-1111-4111-8111-111111111111";
const contributionId = "22222222-2222-4222-8222-222222222222";
const existingGameId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const emptyGame = {} as GameRecord;

type TestLibraryService = Pick<LibraryService, "addManualContribution" | "removeManualContribution" | "editGame" | "deletePlatform" | "deleteTag">;
type TestGamesService = Pick<GamesService, "linkExternalSource" | "refreshExternalMetadata">;

function makeSetup() {
  const addManualContribution = vi.fn(async (): Promise<ManualContributionResult> => ({ status: "created", game: emptyGame, possibleDuplicate: false }));
  const libraryService: TestLibraryService = {
    addManualContribution,
    removeManualContribution: vi.fn(async () => emptyGame),
    editGame: vi.fn(async () => emptyGame),
    deletePlatform: vi.fn(async () => undefined),
    deleteTag: vi.fn(async () => undefined),
  };
  const gamesService: TestGamesService = {
    linkExternalSource: vi.fn(async () => emptyGame),
    refreshExternalMetadata: vi.fn(async () => emptyGame),
  };
  const privateDependencies: PrivateActionDependencies = {
    verifyAccessToken: vi.fn(async () => ({ sub: "owner-subject" })),
    onAccessDenied: vi.fn(async () => undefined),
    onUnhandledFailure: vi.fn(async () => undefined),
  };
  const adapter = createPrivateMutationAdapter({
    getHeaders: async () => new Headers({
      "Cf-Access-Jwt-Assertion": "valid-token",
      "x-request-id": requestId,
    }),
    getPrivateDependencies: () => privateDependencies,
    gamesService,
    libraryService,
  });
  return { adapter, gamesService, libraryService };
}

describe("private mutation adapter", () => {
  it("rejects invalid input before calling the service", async () => {
    const { adapter, libraryService } = makeSetup();

    const result = await adapter.editGame({ gameId: "not-a-uuid" });

    expect(result).toEqual({ ok: false, code: "invalid_input", message: "遊戲資料參數無效。", requestId });
    expect(libraryService.editGame).not.toHaveBeenCalled();
  });

  it("confirmation_required 只回傳候選 matches，不宣稱已建立且不帶 game", async () => {
    const { adapter, libraryService } = makeSetup();
    const matches: readonly ContributorMatch[] = [{
      contributorId: contributionId,
      name: "作者",
      entityKind: "person",
      provider: "bgg",
      sourceContributorId: "bgg-author",
      rolesOnGame: ["design"],
    }];
    vi.mocked(libraryService.addManualContribution).mockResolvedValueOnce({ status: "confirmation_required", matches, possibleDuplicate: true });

    const result = await adapter.addManualContribution({ kind: "new", gameId, name: "作者", entityKind: "person", role: "art", allowDuplicate: false });

    expect(result).toEqual({ ok: true, status: "confirmation_required", matches });
    expect(libraryService.addManualContribution).toHaveBeenCalledWith({ kind: "new", gameId, name: "作者", entityKind: "person", role: "art", allowDuplicate: false });
    expect(result).not.toHaveProperty("game");
  });

  it("created 只回傳最小成功 payload", async () => {
    const { adapter } = makeSetup();

    const result = await adapter.addManualContribution({ kind: "new", gameId, name: "作者", entityKind: "person", role: "design", allowDuplicate: false });

    expect(result).toEqual({ ok: true, status: "created" });
    expect(result).not.toHaveProperty("game");
  });

  it("接受 existing 輸入並回傳 created", async () => {
    const { adapter, libraryService } = makeSetup();

    const result = await adapter.addManualContribution({ kind: "existing", gameId, contributorId: contributionId, role: "art" });

    expect(result).toEqual({ ok: true, status: "created" });
    expect(libraryService.addManualContribution).toHaveBeenCalledWith({ kind: "existing", gameId, contributorId: contributionId, role: "art" });
  });

  it("接受已確認的 new 輸入並回傳 created", async () => {
    const { adapter, libraryService } = makeSetup();

    const result = await adapter.addManualContribution({ kind: "new", gameId, name: "作者", entityKind: "person", role: "publisher", allowDuplicate: true });

    expect(result).toEqual({ ok: true, status: "created" });
    expect(libraryService.addManualContribution).toHaveBeenCalledWith({ kind: "new", gameId, name: "作者", entityKind: "person", role: "publisher", allowDuplicate: true });
  });

  it("拒絕無效的手動貢獻輸入且不呼叫服務", async () => {
    const { adapter, libraryService } = makeSetup();

    const result = await adapter.addManualContribution({ gameId, name: "作者", entityKind: "person", role: "design" });

    expect(result).toEqual({ ok: false, code: "invalid_input", message: "貢獻關係參數無效。", requestId });
    expect(libraryService.addManualContribution).not.toHaveBeenCalled();
  });

  it("removes a contribution without returning the updated game", async () => {
    const { adapter, libraryService } = makeSetup();

    const result = await adapter.removeManualContribution({ gameId, contributionId });

    expect(result).toEqual({ ok: true });
    expect(libraryService.removeManualContribution).toHaveBeenCalledWith(gameId, contributionId);
  });

  it("edits a game without returning the updated game", async () => {
    const { adapter, libraryService } = makeSetup();
    const input = { gameId, displayName: "新名稱", actualPlatforms: ["Steam"], tags: ["合作"], playerCountNote: "備註" };

    const result = await adapter.editGame(input);

    expect(result).toEqual({ ok: true });
    expect(libraryService.editGame).toHaveBeenCalledWith(gameId, { displayName: "新名稱", actualPlatforms: ["Steam"], tags: ["合作"], playerCountNote: "備註" });
  });

  it("links a source and preserves source conflicts without returning a game", async () => {
    const { adapter, gamesService } = makeSetup();
    vi.mocked(gamesService.linkExternalSource).mockRejectedValue(new SourceIdentityConflictError(existingGameId, true));

    const result = await adapter.linkExternalSource({ gameId, provider: "bgg", sourceId: "7", confirmationFingerprint: "fingerprint" });

    expect(result).toEqual({
      ok: false,
      code: "source_operation",
      message: "此來源已存在於資源回收區，請先還原。",
      requestId,
      existingGameId,
      existingIsTrashed: true,
    });
    expect(gamesService.linkExternalSource).toHaveBeenCalledWith({
      gameId,
      ref: { provider: "bgg", medium: "board_game", sourceId: "7" },
      confirmationFingerprint: "fingerprint",
    });
  });

  it("refreshes source data without returning the updated game", async () => {
    const { adapter, gamesService } = makeSetup();

    const result = await adapter.refreshExternalMetadata({ gameId });

    expect(result).toEqual({ ok: true });
    expect(gamesService.refreshExternalMetadata).toHaveBeenCalledWith({ gameId });
  });

  it("deletes a shared platform and tag with minimal success payloads", async () => {
    const { adapter, libraryService } = makeSetup();

    const platformResult = await adapter.deletePlatform({ name: "  Steam  " });
    const tagResult = await adapter.deleteTag({ name: "  合作  " });

    expect(platformResult).toEqual({ ok: true });
    expect(tagResult).toEqual({ ok: true });
    expect(libraryService.deletePlatform).toHaveBeenCalledWith("Steam");
    expect(libraryService.deleteTag).toHaveBeenCalledWith("合作");
  });
});

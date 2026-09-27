import { describe, expect, it, vi } from "vitest";
import { createPrivateListAdapter } from "@/app/private-list-adapter";
import type { GamesService } from "@/modules/games";
import type { SourceSnapshot } from "@/modules/games/internal/types";
import { ListNameInUseError, type ListRecord, type ListsService } from "@/modules/lists";
import type { ExternalReferenceThumbnailService } from "@/modules/lists/external-reference-thumbnail";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import type { PrivateActionDependencies } from "@/shared/auth/private-action";

const commandId = "11111111-1111-4111-8111-111111111111";
const listId = "22222222-2222-4222-8222-222222222222";
const gameId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "13" };
const snapshot: SourceSnapshot = { ref, canonicalUrl: "https://boardgamegeek.com/boardgame/13", title: "Catan", localizedTitle: null, aliases: [], description: null, releaseYear: 1995, coverUrl: "https://cf.geekdo-images.com/catan.jpg", categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] };

function setup(authorized = true, externalThumbnailService?: ExternalReferenceThumbnailService, onExternalThumbnailFailure = vi.fn()) {
  const listsService = {
    list: vi.fn(async () => []), archivedForGame: vi.fn(async () => []), get: vi.fn(async () => null), findName: vi.fn(async () => null),
    create: vi.fn(async () => ({ resourceId: listId, version: 1, state: "active" as const, replayed: false })),
    add: vi.fn(async () => ({ resourceId: listId, version: 2, state: "active" as const, replayed: false })),
    archive: vi.fn(async () => ({ resourceId: listId, version: 2, state: "archived" as const, replayed: false })),
    restore: vi.fn(async () => ({ resourceId: listId, version: 3, state: "active" as const, replayed: false })),
    removeMember: vi.fn(), restoreMember: vi.fn(), describeMember: vi.fn(),
  } as unknown as ListsService;
  const gamesService = { getExternalGameConfirmation: vi.fn(async () => ({ candidate: { ref, title: snapshot.title, releaseYear: snapshot.releaseYear, coverPreviewUrl: null }, snapshot, fingerprint: "fingerprint" })) } as unknown as GamesService;
  const dependencies: PrivateActionDependencies = {
    verifyAccessToken: vi.fn(async () => { if (!authorized) throw new AccessDeniedError(); return { sub: "owner-subject" }; }),
    onAccessDenied: vi.fn(async () => undefined), onUnhandledFailure: vi.fn(async () => undefined),
  };
  return {
    adapter: createPrivateListAdapter({ getHeaders: async () => new Headers({ "Cf-Access-Jwt-Assertion": "token", "x-request-id": requestId }), getPrivateDependencies: () => dependencies, listsService, gamesService, externalThumbnailService, onExternalThumbnailFailure }),
    gamesService, listsService, onExternalThumbnailFailure,
  };
}

describe("private list adapter", () => {
  it("authenticates the owner before persisting a private list", async () => {
    const { adapter, listsService } = setup(false);
    await expect(adapter.create({ commandId, name: "想玩", firstMember: { kind: "game", gameId } })).resolves.toEqual({ ok: false, code: "access_denied", message: "無法驗證存取權限。", requestId });
    expect(listsService.create).not.toHaveBeenCalled();
  });

  it("canonicalizes ids and binds the authenticated owner", async () => {
    const { adapter, listsService } = setup();
    await expect(adapter.create({ commandId: commandId.toUpperCase(), name: "想玩", firstMember: { kind: "game", gameId: gameId.toUpperCase() } })).resolves.toEqual({ ok: true, resourceId: listId, version: 1, state: "active", replayed: false });
    expect(listsService.create).toHaveBeenCalledWith({ commandId, ownerId: "owner-subject", name: "想玩", firstMember: { kind: "game", gameId } });
  });

  it("re-fetches an external candidate instead of trusting browser metadata", async () => {
    const { adapter, gamesService, listsService } = setup();
    await adapter.create({ commandId, name: "想玩", firstMember: { kind: "external", ref, name: "偽造名稱", releaseYear: 1 } });
    expect(gamesService.getExternalGameConfirmation).toHaveBeenCalledWith({ ref });
    expect(listsService.create).toHaveBeenCalledWith(expect.objectContaining({ firstMember: { kind: "external", ref, name: "Catan", releaseYear: 1995 } }));
  });

  it("stores the canonical external cover and keeps the committed list when thumbnail processing fails", async () => {
    const externalThumbnailService = { ensure: vi.fn(async () => { throw new Error("storage unavailable"); }), issueRead: vi.fn() } as unknown as ExternalReferenceThumbnailService;
    const { adapter, onExternalThumbnailFailure } = setup(true, externalThumbnailService);
    await expect(adapter.create({ commandId, name: "想玩", firstMember: { kind: "external", ref, name: "偽造名稱", releaseYear: 1 } }))
      .resolves.toMatchObject({ ok: true, resourceId: listId });
    expect(externalThumbnailService.ensure).toHaveBeenCalledWith(ref, snapshot.coverUrl);
    expect(onExternalThumbnailFailure).toHaveBeenCalledOnce();
  });

  it("returns the archived list needed for the restore path", async () => {
    const { adapter, listsService } = setup();
    const existing: ListRecord = { id: listId, name: "想玩", version: 4, archived: true, memberCount: 2 };
    vi.mocked(listsService.create).mockRejectedValueOnce(new ListNameInUseError(existing));
    await expect(adapter.create({ commandId, name: "想玩", firstMember: { kind: "game", gameId } })).resolves.toEqual({ ok: false, code: "archived_list_found", message: "同名清單已封存，請先還原。", requestId, existingList: existing });
  });
});

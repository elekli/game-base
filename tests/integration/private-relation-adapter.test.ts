import { describe, expect, it, vi } from "vitest";
import { createPrivateRelationAdapter } from "@/app/private-relation-adapter";
import type { GamesService } from "@/modules/games";
import type { SourceSnapshot } from "@/modules/games/internal/types";
import type { RelationsService } from "@/modules/relations";
import type { ExternalReferenceThumbnailService } from "@/modules/lists/external-reference-thumbnail";
import type { PrivateActionDependencies } from "@/shared/auth/private-action";

const commandId = "11111111-1111-4111-8111-111111111111";
const gameId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId: "13" };
const snapshot: SourceSnapshot = { ref, canonicalUrl: "https://boardgamegeek.com/boardgame/13", title: "Catan", localizedTitle: null, aliases: [], description: null, releaseYear: 1995, coverUrl: "https://cf.geekdo-images.com/catan.jpg", categories: [], contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: [] };

describe("private relation adapter", () => {
  it("re-fetches source metadata and persists its private thumbnail after the relation commits", async () => {
    const relationsService = { add: vi.fn(async () => ({ resourceId: "relation-id", version: 1, state: "active" as const, replayed: false })) } as unknown as RelationsService;
    const gamesService = { getExternalGameConfirmation: vi.fn(async () => ({ candidate: { ref, title: snapshot.title, releaseYear: snapshot.releaseYear, coverPreviewUrl: null }, snapshot, fingerprint: "fingerprint" })) } as unknown as GamesService;
    const externalThumbnailService = { ensure: vi.fn(async () => { throw new Error("storage unavailable"); }) } as unknown as ExternalReferenceThumbnailService;
    const onExternalThumbnailFailure = vi.fn(async () => undefined);
    const dependencies: PrivateActionDependencies = { verifyAccessToken: vi.fn(async () => ({ sub: "owner-subject" })), onAccessDenied: vi.fn(), onUnhandledFailure: vi.fn() };
    const adapter = createPrivateRelationAdapter({
      getHeaders: async () => new Headers({ "Cf-Access-Jwt-Assertion": "token", "x-request-id": requestId }),
      getPrivateDependencies: () => dependencies,
      relationsService, gamesService, externalThumbnailService, onExternalThumbnailFailure,
    });

    await expect(adapter.add({ commandId, left: { kind: "game", gameId }, right: { kind: "external", ref } }))
      .resolves.toMatchObject({ ok: true, resourceId: "relation-id" });
    expect(relationsService.add).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner-subject", right: { kind: "external", ref, name: "Catan", releaseYear: 1995 } }));
    expect(externalThumbnailService.ensure).toHaveBeenCalledWith(ref, snapshot.coverUrl);
    expect(onExternalThumbnailFailure).toHaveBeenCalledOnce();
  });
});

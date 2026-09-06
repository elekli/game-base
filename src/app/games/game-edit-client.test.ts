import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/private-mutation-actions", () => ({
  addManualContribution: vi.fn(),
  editGame: vi.fn(),
  linkExternalSource: vi.fn(),
  refreshExternalMetadata: vi.fn(),
  removeManualContribution: vi.fn(),
}));

import { GameEditClient } from "./game-edit-client";
import type { GameRecord } from "@/modules/games";

function sourceGame(contributorId: string | null): GameRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    medium: "board_game",
    displayName: "Legacy game",
    customDisplayName: null,
    sourceNames: ["Legacy game"],
    aliases: [],
    actualPlatforms: [],
    tags: [],
    contributors: [{
      id: "source:bgg:legacy-author:design",
      contributorId,
      name: "Legacy author",
      entityKind: "person",
      role: "design",
      origin: "source",
      provider: "bgg",
      sourceContributorId: "legacy-author",
    }],
    playerCountNote: null,
    coverIngestState: null,
    trashedAt: null,
    externalIdentityId: "22222222-2222-4222-8222-222222222222",
    snapshot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("GameEditClient contributor navigation", () => {
  it("legacy contributor 無本地 UUID 時保留文字但不產生失效收藏庫連結", () => {
    const html = renderToStaticMarkup(createElement(GameEditClient, { game: sourceGame(null) }));

    expect(html).toContain("Legacy author");
    expect(html).not.toContain("?contributor=");
  });

  it("可對應本地 UUID 時產生 UUID 收藏庫連結", () => {
    const html = renderToStaticMarkup(createElement(GameEditClient, { game: sourceGame("33333333-3333-4333-8333-333333333333") }));

    expect(html).toContain("/?contributor=33333333-3333-4333-8333-333333333333");
  });
});

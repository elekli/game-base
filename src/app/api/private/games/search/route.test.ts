import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchExternalGames: vi.fn(),
  searchExternalGamesForMedium: vi.fn(),
  verifyAccessToken: vi.fn(async () => ({ sub: "owner-subject" })),
}));

vi.mock("@/app/games/service", () => ({
	  gamesService: {
	  searchExternalGames: mocks.searchExternalGames,
	  searchExternalGamesForMedium: mocks.searchExternalGamesForMedium,
	},
}));

vi.mock("../_private", () => ({
	  getPrivateDependencies: () => ({
	  verifyAccessToken: mocks.verifyAccessToken,
	  onAccessDenied: vi.fn(),
	  onUnhandledFailure: vi.fn(),
	}),
}));

import { GET } from "./route";

describe("GET /api/private/games/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchExternalGames.mockResolvedValue({ groups: [{ provider: "bgg", items: [], errorCode: null }] });
    mocks.searchExternalGamesForMedium.mockResolvedValue({ groups: [{ provider: "igdb", items: [], errorCode: null }] });
  });

  it.each([
    ["board_game", "bgg"],
    ["video_game", "igdb"],
  ] as const)("帶 %s 媒介時只使用單一媒介搜尋意圖並保留 groups 回應形狀", async (medium, provider) => {
    mocks.searchExternalGamesForMedium.mockResolvedValue({ groups: [{ provider, items: [], errorCode: null }] });
    const response = await GET(new Request(`https://gamebase.example.test/api/private/games/search?q=棋&medium=${medium}`, {
      headers: { "Cf-Access-Jwt-Assertion": "valid-token" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ groups: [{ provider, items: [], errorCode: null }] });
    expect(mocks.searchExternalGamesForMedium).toHaveBeenCalledWith({ query: "棋", medium });
    expect(mocks.searchExternalGames).not.toHaveBeenCalled();
  });

  it("未帶媒介時維持雙來源搜尋", async () => {
    await GET(new Request("https://gamebase.example.test/api/private/games/search?q=棋", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-token" },
    }));

    expect(mocks.searchExternalGames).toHaveBeenCalledWith({ query: "棋" });
    expect(mocks.searchExternalGamesForMedium).not.toHaveBeenCalled();
  });

  it("無效媒介回安全 400，且不呼叫搜尋服務", async () => {
    const response = await GET(new Request("https://gamebase.example.test/api/private/games/search?q=棋&medium=other", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-token" },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "搜尋媒介參數無效。" });
    expect(mocks.searchExternalGames).not.toHaveBeenCalled();
    expect(mocks.searchExternalGamesForMedium).not.toHaveBeenCalled();
  });
});

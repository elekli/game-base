import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  const medium = params.get("medium");
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    if (medium === null) return gamesService.searchExternalGames({ query });
    if (medium !== "board_game" && medium !== "video_game") throw new PrivateRequestInputError("搜尋媒介參數無效。");
    return gamesService.searchExternalGamesForMedium({ query, medium });
  } });
}

import { handlePrivateRequest } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => gamesService.searchExternalGames({ query }) });
}

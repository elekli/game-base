import { handlePrivateRequest } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";

export async function POST(request: Request) {
  const body = await request.json() as { displayName?: string; medium?: "board_game" | "video_game" };
  if (body.displayName === undefined || body.medium === undefined) return Response.json({ message: "手動條目參數無效。" }, { status: 400 });
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => ({ game: await gamesService.createManualGame({ displayName: body.displayName as string, medium: body.medium as "board_game" | "video_game" }) }) });
}

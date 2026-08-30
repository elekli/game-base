import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: { displayName?: unknown; medium?: unknown };
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    if (typeof body.displayName !== "string" || (body.medium !== "board_game" && body.medium !== "video_game")) throw new PrivateRequestInputError("手動條目參數無效。");
    return { game: await gamesService.createManualGame({ displayName: body.displayName, medium: body.medium }) };
  } });
}

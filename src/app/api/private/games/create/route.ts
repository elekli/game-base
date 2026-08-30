import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";
import { assertReference } from "@/modules/games";

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: { provider?: unknown; sourceId?: unknown; confirmationFingerprint?: unknown };
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    if ((body.provider !== "bgg" && body.provider !== "igdb") || typeof body.sourceId !== "string" || typeof body.confirmationFingerprint !== "string") throw new PrivateRequestInputError("建立參數無效。");
    const ref = body.provider === "bgg"
      ? assertReference({ provider: "bgg", medium: "board_game", sourceId: body.sourceId })
      : assertReference({ provider: "igdb", medium: "video_game", sourceId: body.sourceId });
    return gamesService.createGameFromExternalSource({ ref, confirmationFingerprint: body.confirmationFingerprint });
  } });
}

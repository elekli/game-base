import { z } from "zod";
import { gamesService } from "@/app/games/service";
import { assertReference } from "@/modules/games";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { getPrivateDependencies } from "../_private";

const schema = z.object({ gameId: z.uuid(), provider: z.enum(["bgg", "igdb"]), sourceId: z.string(), confirmationFingerprint: z.string().min(1) });

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("來源連結參數無效。");
    const ref = parsed.data.provider === "bgg" ? assertReference({ provider: "bgg", medium: "board_game", sourceId: parsed.data.sourceId }) : assertReference({ provider: "igdb", medium: "video_game", sourceId: parsed.data.sourceId });
    return { game: await gamesService.linkExternalSource({ gameId: parsed.data.gameId, ref, confirmationFingerprint: parsed.data.confirmationFingerprint }) };
  } });
}

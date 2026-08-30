import { z } from "zod";
import { libraryService } from "@/app/games/service";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { getPrivateDependencies } from "../_private";

const schema = z.object({
  gameId: z.uuid(),
  displayName: z.string().trim().max(200).nullable().optional(),
  actualPlatforms: z.array(z.string().trim().max(100)).max(20).optional(),
  tags: z.array(z.string().trim().max(100)).max(50).optional(),
  playerCountNote: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("遊戲資料參數無效。");
    const { gameId, ...input } = parsed.data;
    return { game: await libraryService.editGame(gameId, input) };
  } });
}

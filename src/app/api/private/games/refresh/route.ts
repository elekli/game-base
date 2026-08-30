import { z } from "zod";
import { gamesService } from "@/app/games/service";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { getPrivateDependencies } from "../_private";

const schema = z.object({ gameId: z.uuid() });

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("重新整理參數無效。");
    return { game: await gamesService.refreshExternalMetadata(parsed.data) };
  } });
}

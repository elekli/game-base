import { handlePrivateRequest } from "@/shared/auth/private-request";
import { gamesService } from "@/app/games/service";
import { getPrivateDependencies } from "../_private";

export async function POST(request: Request) {
  const body = await request.json() as { provider?: "bgg" | "igdb"; sourceId?: string; confirmationFingerprint?: string };
  if (body.provider === undefined || body.sourceId === undefined || body.confirmationFingerprint === undefined) return Response.json({ message: "建立參數無效。" }, { status: 400 });
  const confirmationFingerprint = body.confirmationFingerprint;
  const ref = body.provider === "bgg" ? { provider: "bgg" as const, medium: "board_game" as const, sourceId: body.sourceId } : { provider: "igdb" as const, medium: "video_game" as const, sourceId: body.sourceId };
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => gamesService.createGameFromExternalSource({ ref, confirmationFingerprint }) });
}

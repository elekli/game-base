import { z } from "zod";
import { libraryService } from "@/app/games/service";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { getPrivateDependencies } from "../_private";

const createSchema = z.object({ gameId: z.uuid(), name: z.string().trim().min(1).max(200), entityKind: z.enum(["person", "company"]), role: z.enum(["design", "art", "publisher"]) });
const removeSchema = z.object({ gameId: z.uuid(), contributionId: z.uuid() });

export async function POST(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("貢獻關係參數無效。");
    return await libraryService.addManualContribution(parsed.data);
  } });
}

export async function DELETE(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = removeSchema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("貢獻關係參數無效。");
    return { game: await libraryService.removeManualContribution(parsed.data.gameId, parsed.data.contributionId) };
  } });
}

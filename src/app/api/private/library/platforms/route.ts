import { z } from "zod";
import { libraryService } from "@/app/games/service";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import { getPrivateDependencies } from "../../games/_private";

const schema = z.object({ name: z.string().trim().min(1).max(100) });

export async function DELETE(request: Request) {
  return handlePrivateRequest(request, { ...getPrivateDependencies(), operation: async () => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new PrivateRequestInputError("請求格式無效。"); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PrivateRequestInputError("平台參數無效。");
    await libraryService.deletePlatform(parsed.data.name);
    return { deleted: true };
  } });
}

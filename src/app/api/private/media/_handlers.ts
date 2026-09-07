import { z } from "zod";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import type { AccessTokenVerifier } from "@/shared/auth/verify-access-token";
import { MEDIA_MAX_BYTES, type MediaService } from "@/modules/media";

type Dependencies = Readonly<{
  service: MediaService;
  verifyAccessToken: AccessTokenVerifier;
  onAccessDenied: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  onUnhandledFailure: (context: Readonly<{ errorCode: string; requestId: string }>) => void | Promise<void>;
}>;

const beginSchema = z.object({
  idempotencyKey: z.uuid(),
  gameId: z.uuid(),
  purpose: z.enum(["gallery_image", "custom_cover", "attachment"]),
  originalFileName: z.string().trim().min(1).max(255),
  declaredMimeType: z.string().trim().min(1).max(255),
  declaredByteSize: z.number().int().positive().max(MEDIA_MAX_BYTES),
}).strict();
const finalizeSchema = z.object({ idempotencyKey: z.uuid() }).strict();
const assetIdSchema = z.uuid();

function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try { return new URL(origin).origin === new URL(request.url).origin ? origin : null; } catch { return null; }
}

function withCors(request: Request, response: Response): Response {
  const origin = corsOrigin(request);
  if (!origin) return response;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("vary", "Origin");
  return response;
}

function crossOriginResponse(request: Request): Response | null {
  return request.headers.has("origin") && !corsOrigin(request)
    ? Response.json({ message: "不允許跨來源媒體請求。" }, { status: 403, headers: { "cache-control": "private, no-store" } })
    : null;
}

async function json(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new PrivateRequestInputError("媒體請求格式無效。"); }
}

export function createPrivateMediaHandlers(dependencies: Dependencies) {
  const boundary = <Result extends object>(request: Request, operation: Parameters<typeof handlePrivateRequest<Result>>[1]["operation"]) =>
    handlePrivateRequest(request, { ...dependencies, operation });
  return {
    options(request: Request) {
      const origin = corsOrigin(request);
      if (!origin) return new Response(null, { status: 403, headers: { "cache-control": "private, no-store" } });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Cf-Access-Jwt-Assertion, X-Request-Id",
        "access-control-max-age": "600",
        "cache-control": "private, no-store",
        vary: "Origin",
      } });
    },
    async begin(request: Request) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await boundary(request, async (owner) => {
        const parsed = beginSchema.safeParse(await json(request));
        if (!parsed.success) throw new PrivateRequestInputError("媒體上傳參數無效。");
        return dependencies.service.beginMediaUpload(owner, parsed.data);
      }));
    },
    async finalize(request: Request) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await boundary(request, async (owner) => {
        const parsed = finalizeSchema.safeParse(await json(request));
        if (!parsed.success) throw new PrivateRequestInputError("媒體完成確認參數無效。");
        return dependencies.service.finalizeMediaUpload(owner, parsed.data);
      }));
    },
    async original(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await boundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        return dependencies.service.issueOriginalRead(owner, { assetId: parsed.data });
      }));
    },
  };
}

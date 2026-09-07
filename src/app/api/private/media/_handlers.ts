import { z } from "zod";
import { after } from "next/server";
import { handlePrivateRequest, PrivateRequestInputError } from "@/shared/auth/private-request";
import type { AccessTokenVerifier } from "@/shared/auth/verify-access-token";
import { getRequestId } from "@/shared/observability/request-id";
import { MEDIA_MAX_BYTES, type MediaService } from "@/modules/media";
import type { MediaReconcileResult } from "@/modules/media/internal/types";

type Dependencies = Readonly<{
  service: MediaService;
  verifyAccessToken: AccessTokenVerifier;
  onAccessDenied: (context: Readonly<{ requestId: string }>) => void | Promise<void>;
  onUnhandledFailure: (context: Readonly<{ errorCode: string; requestId: string }>) => void | Promise<void>;
  wakeThumbnail?: (assetId: string) => Promise<void>;
  afterResponse?: (task: () => Promise<void>) => void;
  reconcileMedia?: () => Promise<MediaReconcileResult>;
  onReconcile?: (input: Readonly<{ requestId: string; result: MediaReconcileResult }>) => void | Promise<void>;
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
const originalReadSchema = z.object({ disposition: z.enum(["inline", "attachment"]) }).strict();
const metadataSchema = z.object({
  caption: z.string().max(2_000).nullable().optional(),
  displayName: z.string().max(255).nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const coverSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual"), assetId: z.uuid() }).strict(),
  z.object({ mode: z.literal("source") }).strict(),
]);

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
  const afterResponse = dependencies.afterResponse ?? after;
  const observeBackgroundFailure = async (request: Request, errorCode: string) => {
    try { await dependencies.onUnhandledFailure({ errorCode, requestId: getRequestId(request.headers) }); }
    catch { console.error(`${errorCode}_observer_failed`); }
  };
  const boundary = <Result extends object>(request: Request, operation: Parameters<typeof handlePrivateRequest<Result>>[1]["operation"]) =>
    handlePrivateRequest(request, { ...dependencies, operation });
  const scheduleReconcile = (request: Request) => {
    if (!dependencies.reconcileMedia) return;
    const requestId = getRequestId(request.headers);
    afterResponse(async () => {
      try {
        const result = await dependencies.reconcileMedia!();
        await dependencies.onReconcile?.({ requestId, result });
      } catch {
        try { await dependencies.onUnhandledFailure({ errorCode: "media_reconcile_after_failed", requestId }); }
        catch { console.error("media_reconcile_observer_failed"); }
      }
    });
  };
  const authorizedBoundary = <Result extends object>(request: Request, operation: Parameters<typeof handlePrivateRequest<Result>>[1]["operation"]) =>
    boundary(request, async (owner) => {
      try { return await operation(owner); }
      finally { scheduleReconcile(request); }
    });
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
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = beginSchema.safeParse(await json(request));
        if (!parsed.success) throw new PrivateRequestInputError("媒體上傳參數無效。");
        return dependencies.service.beginMediaUpload(owner, parsed.data);
      }));
    },
    async finalize(request: Request) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = finalizeSchema.safeParse(await json(request));
        if (!parsed.success) throw new PrivateRequestInputError("媒體完成確認參數無效。");
        const result = await dependencies.service.finalizeMediaUpload(owner, parsed.data);
        if ("asset" in result && result.thumbnail && dependencies.wakeThumbnail) {
          afterResponse(async () => {
            try { await dependencies.wakeThumbnail?.(result.asset.id); }
            catch { await observeBackgroundFailure(request, "media_thumbnail_wake_failed"); }
          });
        }
        return result;
      }));
    },
    async original(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        const parameters = new URL(request.url).searchParams;
        const query = originalReadSchema.safeParse(Object.fromEntries(parameters));
        if (parameters.size > 1 || (!query.success && parameters.size > 0)) throw new PrivateRequestInputError("媒體讀取參數無效。");
        return dependencies.service.issueOriginalRead(owner, { assetId: parsed.data, disposition: query.success ? query.data.disposition : "attachment" });
      }));
    },
    async thumbnail(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        return dependencies.service.issueThumbnailRead(owner, { assetId: parsed.data });
      }));
    },
    async list(request: Request, gameId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(gameId);
        if (!parsed.success) throw new PrivateRequestInputError("遊戲參數無效。");
        const result = await dependencies.service.listGameMedia(owner, { gameId: parsed.data });
        if (result.sourceCover?.thumbnailError || result.items.some((item) => item.thumbnailError)) {
          afterResponse(() => observeBackgroundFailure(request, "media_thumbnail_read_unavailable"));
        }
        return result;
      }));
    },
    async metadata(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsedId = assetIdSchema.safeParse(assetId);
        const parsed = metadataSchema.safeParse(await json(request));
        if (!parsedId.success || !parsed.success) throw new PrivateRequestInputError("媒體說明參數無效。");
        return dependencies.service.updateMediaMetadata(owner, { assetId: parsedId.data, ...parsed.data });
      }));
    },
    async cover(request: Request, gameId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsedGame = assetIdSchema.safeParse(gameId);
        const parsed = coverSchema.safeParse(await json(request));
        if (!parsedGame.success || !parsed.success) throw new PrivateRequestInputError("封面選擇參數無效。");
        return parsed.data.mode === "source"
          ? dependencies.service.useSourceCover(owner, { gameId: parsedGame.data })
          : dependencies.service.selectManualCover(owner, { gameId: parsedGame.data, assetId: parsed.data.assetId });
      }));
    },
    async retryThumbnail(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        const result = await dependencies.service.retryThumbnail(owner, { assetId: parsed.data });
        if (dependencies.wakeThumbnail) afterResponse(async () => {
          try { await dependencies.wakeThumbnail?.(parsed.data); }
          catch { await observeBackgroundFailure(request, "media_thumbnail_retry_wake_failed"); }
        });
        return result;
      }));
    },
    async remove(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        return dependencies.service.removeMedia(owner, { assetId: parsed.data });
      }));
    },
    async restore(request: Request, assetId: string) {
      const rejected = crossOriginResponse(request); if (rejected) return rejected;
      return withCors(request, await authorizedBoundary(request, async (owner) => {
        const parsed = assetIdSchema.safeParse(assetId);
        if (!parsed.success) throw new PrivateRequestInputError("媒體資產參數無效。");
        return dependencies.service.restoreMedia(owner, { assetId: parsed.data });
      }));
    },
  };
}

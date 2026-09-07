import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../../_handlers";
import { getPrivateMediaDependencies } from "../../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });

export async function GET(request: Request, context: RouteContext<"/api/private/media/assets/[assetId]/thumbnail">) {
  const { assetId } = await context.params;
  const response = await handlers.thumbnail(request, assetId);
  if (!response.ok) return response;
  const body = await response.json() as { url: string };
  return new Response(null, {
    status: 307,
    headers: { location: body.url, "cache-control": "private, no-store" },
  });
}

export const OPTIONS = handlers.options;

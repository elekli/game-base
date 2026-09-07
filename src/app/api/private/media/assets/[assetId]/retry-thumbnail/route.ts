import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../../_handlers";
import { getPrivateMediaDependencies } from "../../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, wakeThumbnail: mediaService.processThumbnail, ...getPrivateMediaDependencies() });
export function POST(request: Request, context: RouteContext<"/api/private/media/assets/[assetId]/retry-thumbnail">) {
  return context.params.then(({ assetId }) => handlers.retryThumbnail(request, assetId));
}
export const OPTIONS = handlers.options;

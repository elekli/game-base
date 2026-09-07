import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../../_handlers";
import { getPrivateMediaDependencies } from "../../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });
export function GET(request: Request, context: RouteContext<"/api/private/media/assets/[assetId]/original">) {
  return context.params.then(({ assetId }) => handlers.original(request, assetId));
}
export const OPTIONS = handlers.options;

import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../../_handlers";
import { getPrivateMediaDependencies } from "../../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });
export function POST(request: Request, context: RouteContext<"/api/private/media/assets/[assetId]/remove">) {
  return context.params.then(({ assetId }) => handlers.remove(request, assetId));
}
export const OPTIONS = handlers.options;

import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../_handlers";
import { getPrivateMediaDependencies } from "../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });
export function GET(request: Request, context: RouteContext<"/api/private/media/games/[gameId]">) {
  return context.params.then(({ gameId }) => handlers.list(request, gameId));
}
export const OPTIONS = handlers.options;

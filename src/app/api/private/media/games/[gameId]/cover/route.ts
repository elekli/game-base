import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../../_handlers";
import { getPrivateMediaDependencies } from "../../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });
export function POST(request: Request, context: RouteContext<"/api/private/media/games/[gameId]/cover">) {
  return context.params.then(({ gameId }) => handlers.cover(request, gameId));
}
export const OPTIONS = handlers.options;

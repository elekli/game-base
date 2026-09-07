import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../_handlers";
import { getPrivateMediaDependencies } from "../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, reconcileMedia: mediaService.reconcileMedia, ...getPrivateMediaDependencies() });
export const POST = handlers.begin;
export const OPTIONS = handlers.options;

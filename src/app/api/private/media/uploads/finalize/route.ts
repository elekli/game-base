import { mediaService } from "@/app/media/service";
import { createPrivateMediaHandlers } from "../../_handlers";
import { getPrivateMediaDependencies } from "../../_private";

const handlers = createPrivateMediaHandlers({ service: mediaService, ...getPrivateMediaDependencies() });
export const POST = handlers.finalize;
export const OPTIONS = handlers.options;

import { z } from "zod";

export const externalGameRefSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("bgg"), medium: z.literal("board_game"), sourceId: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
  z.object({ provider: z.literal("igdb"), medium: z.literal("video_game"), sourceId: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
]);

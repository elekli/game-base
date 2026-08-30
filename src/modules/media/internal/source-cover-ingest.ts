import "server-only";
import { createHash } from "node:crypto";
import { isAllowedSourceCoverUrl } from "./source-cover-policy";

export type MediaIngest = Readonly<{ id: string; sourceUrl: string; originalState: "pending" | "ready" | "failed"; thumbnailState: "pending" | "ready" | "failed"; objectKey: string }>;

export { isAllowedSourceCoverUrl } from "./source-cover-policy";

export function beginSourceCoverIngest(gameId: string, sourceUrl: string): MediaIngest {
  if (!isAllowedSourceCoverUrl(sourceUrl)) throw new Error("來源封面網址不在允許清單。");
  const digest = createHash("sha256").update(`${gameId}:${sourceUrl}`).digest("hex");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return { id, sourceUrl, originalState: "pending", thumbnailState: "pending", objectKey: `games/${gameId}/source/${digest}.bin` };
}

import "server-only";
import { createHash } from "node:crypto";

export type MediaIngest = Readonly<{ id: string; sourceUrl: string; originalState: "pending" | "ready" | "failed"; thumbnailState: "pending" | "ready" | "failed"; objectKey: string }>;

const ALLOWED_HOSTS = new Set(["images.unsplash.com", "images.igdb.com", "cf.geekdo-images.com"]);

export function beginSourceCoverIngest(gameId: string, sourceUrl: string): MediaIngest {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new Error("來源封面網址不在允許清單。");
  const digest = createHash("sha256").update(`${gameId}:${sourceUrl}`).digest("hex");
  return { id: digest.slice(0, 32), sourceUrl, originalState: "pending", thumbnailState: "pending", objectKey: `games/${gameId}/source/${digest}.bin` };
}

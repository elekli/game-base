import "server-only";
import { createHash } from "node:crypto";
import { isAllowedSourceCoverUrl } from "./source-cover-policy";

export type SourceCoverIngest = Readonly<{ id: string; idempotencyKey: string; reservedAssetId: string; externalGameIdentityId: string; sourceUrl: string; originalState: "pending" | "ready" | "failed"; thumbnailState: "pending" | "ready" | "failed"; objectKey: string }>;

export { isAllowedSourceCoverUrl } from "./source-cover-policy";

function uuidFromDigest(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function beginSourceCoverIngest(operationId: string, gameId: string, externalGameIdentityId: string, sourceUrl: string): SourceCoverIngest {
  if (!isAllowedSourceCoverUrl(sourceUrl)) throw new Error("來源封面網址不在允許清單。");
  const identity = `${operationId}:${gameId}:${externalGameIdentityId}:${sourceUrl}`;
  const ingestDigest = createHash("sha256").update(`ingest:${identity}`).digest("hex");
  const assetDigest = createHash("sha256").update(`asset:${identity}`).digest("hex");
  const objectDigest = createHash("sha256").update(`object:${identity}`).digest("hex");
  const id = uuidFromDigest(ingestDigest);
  const reservedAssetId = uuidFromDigest(assetDigest);
  return { id, idempotencyKey: id, reservedAssetId, externalGameIdentityId, sourceUrl, originalState: "pending", thumbnailState: "pending", objectKey: `originals/${reservedAssetId}/${uuidFromDigest(objectDigest)}` };
}

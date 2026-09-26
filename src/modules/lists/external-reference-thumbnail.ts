import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { NamedError } from "@/shared/errors/named-error";
import type { ExternalGameRef } from "@/modules/games/internal/types";
import { MEDIA_MAX_BYTES } from "@/modules/media";
import { transformThumbnail } from "@/modules/media/internal/thumbnail-transform";
import { isAllowedSourceCoverUrl } from "@/modules/media/internal/source-cover-ingest";

export type ExternalThumbnailClaim = Readonly<{ status: "busy" | "not_found" | "ready" } | { status: "claimed"; identityId: string; leaseToken: string }>;
export interface ExternalThumbnailStore {
  claim(ref: ExternalGameRef, lease: Readonly<{ token: string; until: string }>): Promise<ExternalThumbnailClaim>;
  complete(identityId: string, leaseToken: string, objectKey: string): Promise<boolean>;
  fail(identityId: string, leaseToken: string): Promise<void>;
}
export interface ExternalThumbnailObjects {
  upload(objectKey: string, bytes: Uint8Array): Promise<void>;
  issueRead(objectKey: string): Promise<string>;
}

export class ExternalReferenceThumbnailUnavailableError extends NamedError {
  constructor() { super("external_reference_thumbnail_unavailable", "庫外遊戲封面縮圖暫時無法保存。"); this.name = "ExternalReferenceThumbnailUnavailableError"; }
}

async function* responseChunks(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) throw new ExternalReferenceThumbnailUnavailableError();
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally { reader.releaseLock(); }
}

async function fetchCover(fetcher: typeof fetch, sourceUrl: string): Promise<Response> {
  let current = sourceUrl;
  const signal = AbortSignal.timeout(12_000);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isAllowedSourceCoverUrl(current)) throw new ExternalReferenceThumbnailUnavailableError();
    const response = await fetcher(current, { redirect: "manual", signal, headers: { accept: "image/*" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new ExternalReferenceThumbnailUnavailableError();
      current = new URL(location, current).toString();
      continue;
    }
    const declared = Number(response.headers.get("content-length"));
    if (!response.ok || (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES)) throw new ExternalReferenceThumbnailUnavailableError();
    return response;
  }
  throw new ExternalReferenceThumbnailUnavailableError();
}

export function createExternalReferenceThumbnailService(input: Readonly<{ store: ExternalThumbnailStore; objects: ExternalThumbnailObjects; fetcher?: typeof fetch; now?: () => Date }>) {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? (() => new Date());
  return {
    async ensure(ref: ExternalGameRef, coverUrl: string | null): Promise<void> {
      if (!coverUrl || !isAllowedSourceCoverUrl(coverUrl)) return;
      const leaseToken = randomUUID();
      const claim = await input.store.claim(ref, { token: leaseToken, until: new Date(now().getTime() + 60_000).toISOString() });
      if (claim.status !== "claimed") return;
      try {
        const response = await fetchCover(fetcher, coverUrl);
        const thumbnail = await transformThumbnail(responseChunks(response));
        const fingerprint = createHash("sha256").update(`${ref.provider}:${ref.sourceId}:${coverUrl}`).digest("hex");
        const objectKey = `external-reference-thumbnails/${claim.identityId}/${fingerprint}.webp`;
        await input.objects.upload(objectKey, thumbnail.bytes);
        if (!await input.store.complete(claim.identityId, claim.leaseToken, objectKey)) throw new ExternalReferenceThumbnailUnavailableError();
      } catch (error) {
        try { await input.store.fail(claim.identityId, claim.leaseToken); }
        catch { throw new ExternalReferenceThumbnailUnavailableError(); }
        throw error instanceof ExternalReferenceThumbnailUnavailableError ? error : new ExternalReferenceThumbnailUnavailableError();
      }
    },
    issueRead: (objectKey: string) => input.objects.issueRead(objectKey),
  };
}

export type ExternalReferenceThumbnailService = ReturnType<typeof createExternalReferenceThumbnailService>;

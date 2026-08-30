import { createHash } from "node:crypto";
import type { SourceSnapshot } from "./types";

export function confirmationFingerprint(snapshot: SourceSnapshot): string {
  const contributors = snapshot.contributors
    .filter((item) => item.role === "design" || item.role === "developer" || item.role === "publisher")
    .map((item) => [item.sourceContributorId, item.name, item.role])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const platforms = [...snapshot.supportedPlatforms].sort();
  return createHash("sha256")
    .update(JSON.stringify({
      provider: snapshot.ref.provider,
      sourceId: snapshot.ref.sourceId,
      title: snapshot.title,
      releaseYear: snapshot.releaseYear,
      contributors,
      platforms,
    }))
    .digest("hex");
}

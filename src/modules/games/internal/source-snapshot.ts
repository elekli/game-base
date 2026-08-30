import { SourceResponseInvalidError } from "./errors";
import type { ExternalGameRef, SourceSnapshot } from "./types";

const HTTPS = /^https:\/\//i;
const SOURCE_CATEGORY_KINDS: Readonly<Record<ExternalGameRef["provider"], ReadonlySet<string>>> = {
  bgg: new Set(["category", "mechanic"]),
  igdb: new Set(["genre", "theme", "game_mode", "player_perspective"]),
};

export function normalizeSourceId(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) throw new SourceResponseInvalidError();
  const normalized = trimmed.replace(/^0+(?=\d)/, "");
  if (normalized.length > 18) throw new SourceResponseInvalidError();
  return normalized;
}

export function assertReference(ref: ExternalGameRef): ExternalGameRef {
  return { ...ref, sourceId: normalizeSourceId(ref.sourceId) } as ExternalGameRef;
}

export function validateSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  if (!HTTPS.test(snapshot.canonicalUrl) || (snapshot.coverUrl !== null && !HTTPS.test(snapshot.coverUrl))) {
    throw new SourceResponseInvalidError();
  }
  if (!snapshot.title.trim() || snapshot.releaseYear !== null && (snapshot.releaseYear < 1800 || snapshot.releaseYear > 2200)) {
    throw new SourceResponseInvalidError();
  }
  if (snapshot.minPlayers !== null || snapshot.maxPlayers !== null) {
    if (snapshot.minPlayers === null || snapshot.maxPlayers === null || snapshot.minPlayers < 1 || snapshot.maxPlayers < 1 || snapshot.minPlayers > snapshot.maxPlayers) {
      throw new SourceResponseInvalidError();
    }
  }
  if (snapshot.weight !== null && (snapshot.weight < 1 || snapshot.weight > 5)) throw new SourceResponseInvalidError();
  if (snapshot.strategyRank !== null && (!Number.isInteger(snapshot.strategyRank) || snapshot.strategyRank < 1)) throw new SourceResponseInvalidError();
  if (snapshot.ref.provider === "bgg" && snapshot.ref.medium !== "board_game") throw new SourceResponseInvalidError();
  if (snapshot.ref.provider === "igdb" && snapshot.ref.medium !== "video_game") throw new SourceResponseInvalidError();
  return { ...snapshot, categories: snapshot.categories.filter((category) => SOURCE_CATEGORY_KINDS[snapshot.ref.provider].has(category.kind)) };
}

import {
  SourceNotFoundError,
  SourceRateLimitedError,
  SourceUnavailableError,
} from "@/modules/games/internal/errors";
import { assertReference } from "@/modules/games/internal/source-snapshot";
import type {
  ExternalGameRef,
  NormalizedSearchCandidate,
  SourceCatalogPort,
  SourceSearchQuery,
  SourceSnapshot,
} from "@/modules/games/internal/types";

export type FixtureScenario = "ok" | "unavailable" | "rate_limited" | "not_found";

export class TestCatalogAdapter implements SourceCatalogPort {
  readonly provider: ExternalGameRef["provider"];
  private scenario: FixtureScenario = "ok";
  private readonly candidates: NormalizedSearchCandidate[];
  private readonly snapshots = new Map<string, SourceSnapshot>();

  constructor(provider: ExternalGameRef["provider"], fixtures: readonly SourceSnapshot[] = []) {
    this.provider = provider;
    this.candidates = fixtures.map((snapshot) => ({
      ref: snapshot.ref,
      title: snapshot.title,
      releaseYear: snapshot.releaseYear,
      coverPreviewUrl: snapshot.coverUrl,
    }));
    for (const snapshot of fixtures) this.snapshots.set(snapshot.ref.sourceId.replace(/^0+(?=\d)/, ""), snapshot);
  }

  setScenario(scenario: FixtureScenario) { this.scenario = scenario; }
  setSnapshot(snapshot: SourceSnapshot) { this.snapshots.set(snapshot.ref.sourceId.replace(/^0+(?=\d)/, ""), snapshot); }

  async search(input: SourceSearchQuery): Promise<readonly NormalizedSearchCandidate[]> {
    if (input.provider !== this.provider) return [];
    if (!input.query.trim()) return [];
    if (this.scenario === "unavailable") throw new SourceUnavailableError();
    if (this.scenario === "rate_limited") throw new SourceRateLimitedError(1);
    return this.candidates.filter((item) => item.title.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())).slice(0, input.limit ?? 20);
  }

  async fetchSnapshot(ref: ExternalGameRef): Promise<SourceSnapshot> {
    const normalized = assertReference(ref);
    if (this.scenario === "unavailable") throw new SourceUnavailableError();
    if (this.scenario === "rate_limited") throw new SourceRateLimitedError(1);
    const snapshot = this.snapshots.get(normalized.sourceId);
    if (!snapshot) throw new SourceNotFoundError();
    return snapshot;
  }
}

export function sampleFixture(provider: "bgg" | "igdb", sourceId: string, title: string): SourceSnapshot {
  const ref = provider === "bgg"
    ? { provider: "bgg" as const, medium: "board_game" as const, sourceId }
    : { provider: "igdb" as const, medium: "video_game" as const, sourceId };
  return {
    ref,
    canonicalUrl: `https://${provider}.example.test/${sourceId}`,
    title,
    localizedTitle: null,
    aliases: [],
    description: null,
    releaseYear: 2024,
    coverUrl: null,
    categories: [],
    contributors: [],
    minPlayers: provider === "bgg" ? 1 : null,
    maxPlayers: provider === "bgg" ? 4 : null,
    supportsSolo: "unknown",
    playtimeMinutes: null,
    weight: provider === "bgg" ? 3.2 : null,
    strategyRank: null,
    supportedPlatforms: provider === "igdb" ? ["PC"] : [],
  };
}

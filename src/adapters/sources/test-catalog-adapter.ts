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

type FixtureGlobalState = typeof globalThis & { __puizeruGamebaseFixtureState?: { refreshFailures: Map<string, number>; freshFetches: Map<string, number> } };
const fixtureGlobal = globalThis as FixtureGlobalState;
const fixtureState = fixtureGlobal.__puizeruGamebaseFixtureState ??= { refreshFailures: new Map(), freshFetches: new Map() };

export class TestCatalogAdapter implements SourceCatalogPort {
  readonly provider: ExternalGameRef["provider"];
  private scenario: FixtureScenario = "ok";
  private readonly candidates: NormalizedSearchCandidate[];
  private readonly snapshots = new Map<string, SourceSnapshot>();
  private readonly refreshFailures = fixtureState.refreshFailures;
  private readonly freshFetches = fixtureState.freshFetches;

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
  setRefreshFailures(sourceId: string, count: number) {
    const key = `${this.provider}:${sourceId.replace(/^0+(?=\d)/, "")}`;
    this.refreshFailures.set(key, count);
    this.freshFetches.delete(key);
  }

  async search(input: SourceSearchQuery): Promise<readonly NormalizedSearchCandidate[]> {
    if (input.provider !== this.provider) return [];
    if (!input.query.trim()) return [];
    if (this.scenario === "unavailable") throw new SourceUnavailableError();
    if (this.scenario === "rate_limited") throw new SourceRateLimitedError(1);
    return this.candidates.filter((item) => item.title.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())).slice(0, input.limit ?? 20);
  }

  async fetchSnapshot(ref: ExternalGameRef, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<SourceSnapshot> {
    const normalized = assertReference(ref);
    if (freshness === "fresh") {
      const sourceKey = `${this.provider}:${normalized.sourceId}`;
      const fetchCount = (this.freshFetches.get(sourceKey) ?? 0) + 1;
      this.freshFetches.set(sourceKey, fetchCount);
      const failures = this.refreshFailures.get(sourceKey) ?? 0;
      if (fetchCount > 1 && failures > 0) {
        this.refreshFailures.set(sourceKey, failures - 1);
        throw new SourceUnavailableError();
      }
    }
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

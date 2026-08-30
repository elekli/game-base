export type Provider = "bgg" | "igdb";
export type Medium = "board_game" | "video_game";

export type ExternalGameRef =
  | { readonly provider: "bgg"; readonly medium: "board_game"; readonly sourceId: string }
  | { readonly provider: "igdb"; readonly medium: "video_game"; readonly sourceId: string };

export type SourceSearchQuery = Readonly<{
  provider: Provider;
  query: string;
  limit?: number;
}>;

export type NormalizedSearchCandidate = Readonly<{
  ref: ExternalGameRef;
  title: string;
  releaseYear: number | null;
  coverPreviewUrl: string | null;
}>;

export type SourceCategory = Readonly<{
  kind: string;
  sourceCategoryId: string;
  name: string;
}>;

export type SourceContributor = Readonly<{
  sourceContributorId: string;
  name: string;
  entityKind: "person" | "company";
  role: "design" | "art" | "publisher" | "developer";
}>;

export type SourceSnapshot = Readonly<{
  ref: ExternalGameRef;
  canonicalUrl: string;
  title: string;
  localizedTitle: string | null;
  aliases: readonly string[];
  description: string | null;
  releaseYear: number | null;
  coverUrl: string | null;
  categories: readonly SourceCategory[];
  contributors: readonly SourceContributor[];
  minPlayers: number | null;
  maxPlayers: number | null;
  supportsSolo: "supported" | "unsupported" | "unknown";
  playtimeMinutes: number | null;
  weight: number | null;
  strategyRank: number | null;
  supportedPlatforms: readonly string[];
}>;

export type GameContribution = Readonly<{
  id: string;
  name: string;
  entityKind: "person" | "company";
  role: "design" | "art" | "publisher" | "developer";
  origin: "source" | "manual";
  provider: Provider | null;
  sourceContributorId: string | null;
}>;

export type SourceCatalogPort = Readonly<{
  search(input: SourceSearchQuery): Promise<readonly NormalizedSearchCandidate[]>;
  fetchSnapshot(ref: ExternalGameRef, freshness: "cache_ok" | "fresh"): Promise<SourceSnapshot>;
}>;

export type GameRecord = Readonly<{
  id: string;
  medium: Medium;
  displayName: string;
  customDisplayName: string | null;
  sourceNames: readonly string[];
  aliases: readonly string[];
  actualPlatforms: readonly string[];
  tags: readonly string[];
  contributors: readonly GameContribution[];
  playerCountNote: string | null;
  trashedAt: string | null;
  externalIdentityId: string | null;
  snapshot: SourceSnapshot | null;
  createdAt: string;
}>;

export type Confirmation = Readonly<{
  candidate: NormalizedSearchCandidate;
  snapshot: SourceSnapshot;
  fingerprint: string;
}>;

export type CreateGameResult = Readonly<{
  game: GameRecord;
  created: boolean;
  identityConflict: "active" | "trashed" | null;
}>;

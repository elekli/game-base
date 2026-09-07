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

export type LibrarySort = "name" | "recent" | "weight_asc" | "weight_desc" | "strategy_rank";
export type ContributionRole = "design" | "art" | "publisher";

export type ContributorRoleFilter = Readonly<{
  role: ContributionRole;
  contributorIds: readonly string[];
}>;

export type LibraryGameQuery = Readonly<{
  search?: string;
  media?: readonly Medium[];
  actualPlatforms?: readonly string[];
  tags?: readonly string[];
  contributorRoles?: readonly ContributorRoleFilter[];
  /** @deprecated 舊版貢獻者網址相容；新的篩選使用 contributorRoles。 */
  contributorIds?: readonly string[];
  sourceCategories?: readonly Pick<SourceCategory, "kind" | "sourceCategoryId">[];
  weightMin?: number | null;
  weightMax?: number | null;
  sort?: LibrarySort;
}>;

export type SourceContributor = Readonly<{
  sourceContributorId: string;
  name: string;
  entityKind: "person" | "company";
  role: ContributionRole;
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

type GameContributionBase = Readonly<{
  id: string;
  name: string;
  entityKind: "person" | "company";
  role: "design" | "art" | "publisher";
}>;

export type GameContribution = GameContributionBase & (
  | Readonly<{ contributorId: string | null; origin: "source"; provider: Provider; sourceContributorId: string }>
  | Readonly<{ contributorId: string; origin: "manual"; provider: null; sourceContributorId: null }>
);

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
  coverIngestState: "pending" | "ready" | "failed" | null;
  coverAssetId?: string | null;
  coverThumbnailState?: "pending" | "processing" | "ready" | "failed" | null;
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

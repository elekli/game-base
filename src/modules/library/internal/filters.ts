import type { GameRecord, Medium } from "@/modules/games";

export type LibrarySort = "name" | "recent" | "weight_asc" | "weight_desc" | "strategy_rank";

export type LibraryFilters = Readonly<{
  query?: string;
  media?: readonly Medium[];
  platforms?: readonly string[];
  tags?: readonly string[];
  sourceCategories?: readonly Readonly<{ kind: string; sourceCategoryId: string }>[];
  contributors?: readonly string[];
  weightMin?: number | null;
  weightMax?: number | null;
  sort?: LibrarySort;
}>;

function includesNormalized(values: readonly string[], selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  const available = new Set(values.map((value) => value.toLocaleLowerCase("en-US")));
  return selected.some((value) => available.has(value.trim().toLocaleLowerCase("en-US")));
}

function matchesCategories(game: GameRecord, selected: LibraryFilters["sourceCategories"]): boolean {
  if (!selected || selected.length === 0) return true;
  const categories = game.snapshot?.categories ?? [];
  const selectedByKind = new Map<string, Set<string>>();
  for (const category of selected) {
    const set = selectedByKind.get(category.kind) ?? new Set<string>();
    set.add(category.sourceCategoryId);
    selectedByKind.set(category.kind, set);
  }
  return [...selectedByKind].every(([kind, ids]) => categories.some((category) => category.kind === kind && ids.has(category.sourceCategoryId)));
}

function matchesContributors(game: GameRecord, selected: readonly string[] | undefined): boolean {
  if (!selected || selected.length === 0) return true;
  const contributorKeys = new Set(game.contributors.map((contributor) => contributor.id));
  return selected.some((id) => contributorKeys.has(id));
}

function compareNullableNumber(a: number | null, b: number | null, direction: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

export function filterAndSortGames(games: readonly GameRecord[], filters: LibraryFilters = {}): readonly GameRecord[] {
  const query = filters.query?.trim().toLocaleLowerCase("en-US") ?? "";
  const media = filters.media ?? [];
  const filtered = games.filter((game) => {
    const names = [game.displayName, ...game.sourceNames, ...game.aliases].map((name) => name.toLocaleLowerCase("en-US"));
    if (query && !names.some((name) => name.includes(query))) return false;
    if (media.length > 0 && !media.includes(game.medium)) return false;
    if (!includesNormalized(game.actualPlatforms, filters.platforms ?? [])) return false;
    if (!includesNormalized(game.tags, filters.tags ?? [])) return false;
    if (!matchesCategories(game, filters.sourceCategories)) return false;
    if (!matchesContributors(game, filters.contributors)) return false;
    const weight = game.snapshot?.weight ?? null;
    if (filters.weightMin !== null && filters.weightMin !== undefined && (weight === null || weight < filters.weightMin)) return false;
    if (filters.weightMax !== null && filters.weightMax !== undefined && (weight === null || weight > filters.weightMax)) return false;
    return true;
  });
  const sort = filters.sort ?? "name";
  return [...filtered].sort((a, b) => {
    if (sort === "recent") return b.createdAt.localeCompare(a.createdAt);
    if (sort === "weight_asc") return compareNullableNumber(a.snapshot?.weight ?? null, b.snapshot?.weight ?? null, "asc");
    if (sort === "weight_desc") return compareNullableNumber(a.snapshot?.weight ?? null, b.snapshot?.weight ?? null, "desc");
    if (sort === "strategy_rank") return compareNullableNumber(a.snapshot?.strategyRank ?? null, b.snapshot?.strategyRank ?? null, "asc");
    return a.displayName.localeCompare(b.displayName, "zh-Hant");
  });
}

export function compatibleSourceCategoryKinds(media: readonly Medium[]): readonly string[] {
  if (media.length !== 1) return [];
  return media[0] === "board_game" ? ["category", "mechanic"] : ["genre", "theme", "game_mode", "player_perspective"];
}

export function clearIncompatibleSourceCategories(
  media: readonly Medium[],
  categories: LibraryFilters["sourceCategories"],
): readonly Readonly<{ kind: string; sourceCategoryId: string }>[] {
  const allowed = new Set(compatibleSourceCategoryKinds(media));
  if (allowed.size === 0 || !categories) return [];
  return categories.filter((category) => allowed.has(category.kind));
}

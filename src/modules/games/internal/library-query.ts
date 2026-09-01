import type { GameRecord, LibraryGameQuery, Medium, Provider, SourceCategory } from "./types";

const categoryKinds: Readonly<Record<Medium, readonly string[]>> = {
  board_game: ["category", "mechanic"],
  video_game: ["genre", "theme", "game_mode", "player_perspective"],
};

const providers: Readonly<Record<Medium, Provider>> = {
  board_game: "bgg",
  video_game: "igdb",
};

function nullableNumber(value: number | null, other: number | null, direction: "asc" | "desc"): number {
  if (value === null && other === null) return 0;
  if (value === null) return 1;
  if (other === null) return -1;
  return direction === "asc" ? value - other : other - value;
}

function sourceCategoriesMatch(game: GameRecord, selected: LibraryGameQuery["sourceCategories"]): boolean {
  if (!selected || selected.length === 0) return true;
  const byKind = new Map<string, Set<string>>();
  for (const category of selected) {
    const ids = byKind.get(category.kind) ?? new Set<string>();
    ids.add(category.sourceCategoryId);
    byKind.set(category.kind, ids);
  }
  return [...byKind].every(([kind, ids]) => game.snapshot?.categories.some((category) => category.kind === kind && ids.has(category.sourceCategoryId)) ?? false);
}

export function filterAndSortLibraryGames(games: readonly GameRecord[], query: LibraryGameQuery = {}): readonly GameRecord[] {
  const filtered = games.filter((game) => {
    if (query.media?.length && !query.media.includes(game.medium)) return false;
    if (!sourceCategoriesMatch(game, query.sourceCategories)) return false;
    const weight = game.snapshot?.weight ?? null;
    if (query.weightMin !== undefined && query.weightMin !== null && (weight === null || weight < query.weightMin)) return false;
    if (query.weightMax !== undefined && query.weightMax !== null && (weight === null || weight > query.weightMax)) return false;
    return true;
  });
  const sort = query.sort ?? "name";
  return [...filtered].sort((left, right) => {
    const numeric = sort === "weight_asc"
      ? nullableNumber(left.snapshot?.weight ?? null, right.snapshot?.weight ?? null, "asc")
      : sort === "weight_desc"
        ? nullableNumber(left.snapshot?.weight ?? null, right.snapshot?.weight ?? null, "desc")
        : sort === "strategy_rank"
          ? nullableNumber(left.snapshot?.strategyRank ?? null, right.snapshot?.strategyRank ?? null, "asc")
          : 0;
    if (numeric !== 0) return numeric;
    if (sort === "recent") {
      const recent = right.createdAt.localeCompare(left.createdAt);
      if (recent !== 0) return recent;
    } else {
      const name = left.displayName.localeCompare(right.displayName, "zh-Hant");
      if (name !== 0) return name;
    }
    return left.id.localeCompare(right.id);
  });
}

export function sourceCategoryFacets(games: readonly GameRecord[], medium: Medium): readonly SourceCategory[] {
  const allowed = new Set(categoryKinds[medium]);
  const facets = new Map<string, SourceCategory>();
  for (const game of games) {
    if (game.medium !== medium || game.snapshot?.ref.provider !== providers[medium]) continue;
    for (const category of game.snapshot?.categories ?? []) {
      if (allowed.has(category.kind)) facets.set(`${category.kind}:${category.sourceCategoryId}`, category);
    }
  }
  return [...facets.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hant") || left.kind.localeCompare(right.kind) || left.sourceCategoryId.localeCompare(right.sourceCategoryId));
}

export function compatibleSourceCategoryKinds(media: readonly Medium[]): readonly string[] {
  return media.length === 1 ? categoryKinds[media[0]] : [];
}

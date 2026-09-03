import { compatibleSourceCategoryKinds, filterAndSortLibraryGames } from "@/modules/games/internal/library-query";
import type { LibraryGameQuery, LibrarySort, Medium } from "@/modules/games";

export type { LibrarySort };
export type LibraryFilters = LibraryGameQuery;

export const filterAndSortGames = filterAndSortLibraryGames;
export { compatibleSourceCategoryKinds };

export function clearIncompatibleSourceCategories(
  media: readonly Medium[],
  categories: LibraryFilters["sourceCategories"],
): readonly NonNullable<LibraryFilters["sourceCategories"]>[number][] {
  const allowed = new Set(compatibleSourceCategoryKinds(media));
  if (allowed.size === 0 || !categories) return [];
  return categories.filter((category) => allowed.has(category.kind));
}

import { clearIncompatibleSourceCategories, type LibraryFilters } from "./internal/filters";
import type { GameRecord, Medium, SourceCategory } from "@/modules/games";
import type { GameEditInput, GameStore, ManualContributionInput, ManualContributionResult, SharedLibraryItem } from "@/modules/games";

export type LibraryService = Readonly<{
  listGames(filters?: LibraryFilters): Promise<readonly GameRecord[]>;
  listSourceCategoryFacets(media: readonly Medium[]): Promise<readonly SourceCategory[]>;
  editGame(gameId: string, input: GameEditInput): Promise<GameRecord>;
  addManualContribution(input: ManualContributionInput): Promise<ManualContributionResult>;
  removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord>;
  deletePlatform(name: string): Promise<void>;
  deleteTag(name: string): Promise<void>;
  listPlatforms(): Promise<readonly SharedLibraryItem[]>;
  listTags(): Promise<readonly SharedLibraryItem[]>;
}>;

export function createLibraryService(store: GameStore): LibraryService {
  return {
    async listGames(filters = {}) {
      const isBoardOnly = filters.media?.length === 1 && filters.media[0] === "board_game";
      const sort = filters.sort === "name" || filters.sort === "recent"
        ? filters.sort
        : isBoardOnly && (filters.sort === "weight_asc" || filters.sort === "weight_desc" || filters.sort === "strategy_rank")
          ? filters.sort
          : "name";
      const compatibleFilters = {
        ...filters,
        sourceCategories: clearIncompatibleSourceCategories(filters.media ?? [], filters.sourceCategories),
        weightMin: isBoardOnly ? filters.weightMin : undefined,
        weightMax: isBoardOnly ? filters.weightMax : undefined,
        sort,
      };
      return store.listLibraryGames(compatibleFilters);
    },
    listSourceCategoryFacets(media) {
      return media.length === 1 ? store.listSourceCategoryFacets(media[0]) : Promise.resolve([]);
    },
    editGame(gameId, input) { return store.edit(gameId, input); },
    addManualContribution(input) { return store.addManualContribution(input); },
    removeManualContribution(gameId, contributionId) { return store.removeManualContribution(gameId, contributionId); },
    deletePlatform(name) { return store.deletePlatform(name); },
    deleteTag(name) { return store.deleteTag(name); },
    listPlatforms() { return store.listPlatforms(); },
    listTags() { return store.listTags(); },
  };
}

export * from "./internal/filters";
export * from "./internal/errors";
export * from "./internal/names";

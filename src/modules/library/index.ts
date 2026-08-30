import { clearIncompatibleSourceCategories, filterAndSortGames, type LibraryFilters } from "./internal/filters";
import type { GameRecord } from "@/modules/games";
import type { GameEditInput, GameStore, ManualContributionInput, ManualContributionResult } from "@/modules/games";

export type LibraryService = Readonly<{
  listGames(filters?: LibraryFilters): Promise<readonly GameRecord[]>;
  editGame(gameId: string, input: GameEditInput): Promise<GameRecord>;
  addManualContribution(input: ManualContributionInput): Promise<ManualContributionResult>;
  removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord>;
  deletePlatform(name: string): Promise<void>;
  deleteTag(name: string): Promise<void>;
}>;

export function createLibraryService(store: GameStore): LibraryService {
  return {
    async listGames(filters = {}) {
      const isBoardOnly = filters.media?.length === 1 && filters.media[0] === "board_game";
      const compatibleFilters = {
        ...filters,
        sourceCategories: clearIncompatibleSourceCategories(filters.media ?? [], filters.sourceCategories),
        weightMin: isBoardOnly ? filters.weightMin : undefined,
        weightMax: isBoardOnly ? filters.weightMax : undefined,
        sort: isBoardOnly || filters.sort === "name" || filters.sort === "recent" ? filters.sort : "name",
      };
      return filterAndSortGames(await store.list(compatibleFilters.query), compatibleFilters);
    },
    editGame(gameId, input) { return store.edit(gameId, input); },
    addManualContribution(input) { return store.addManualContribution(input); },
    removeManualContribution(gameId, contributionId) { return store.removeManualContribution(gameId, contributionId); },
    deletePlatform(name) { return store.deletePlatform(name); },
    deleteTag(name) { return store.deleteTag(name); },
  };
}

export * from "./internal/filters";
export * from "./internal/names";

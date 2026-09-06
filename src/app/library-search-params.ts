import type { ContributionRole, Medium } from "@/modules/games";
import { cleanSharedNames, clearIncompatibleSourceCategories, type LibraryFilters, type LibrarySort } from "@/modules/library";

const localContributorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contributorRoles = ["design", "art", "publisher"] as const satisfies readonly ContributionRole[];

function cleanContributorIds(values: readonly FormDataEntryValue[]): string[] {
  const ids = new Set<string>();
  for (const value of values) if (typeof value === "string" && localContributorId.test(value)) ids.add(value.toLowerCase());
  return [...ids];
}

export function buildLibrarySearchParams(form: FormData): URLSearchParams {
  const media = form.getAll("medium").filter((value): value is string => value === "board_game" || value === "video_game");
  const boardOnly = media.length === 1 && media[0] === "board_game";
  const params = new URLSearchParams();
  const search = form.get("search");
  if (typeof search === "string" && search.trim()) params.set("search", search.trim());
  for (const medium of media) params.append("medium", medium);
  for (const platform of cleanSharedNames(form.getAll("platform").filter((value): value is string => typeof value === "string"))) params.append("platform", platform);
  for (const tag of cleanSharedNames(form.getAll("tag").filter((value): value is string => typeof value === "string"))) params.append("tag", tag);
  for (const contributorId of cleanContributorIds(form.getAll("contributor"))) params.append("contributor", contributorId);
  for (const role of contributorRoles) {
    for (const contributorId of cleanContributorIds(form.getAll(`contributor-${role}`))) params.append(`contributor-${role}`, contributorId);
  }
  if (media.length === 1) {
    for (const category of form.getAll("category")) if (typeof category === "string") params.append("category", category);
  }
  const sort = form.get("sort");
  const allowedSort = boardOnly && (sort === "weight_asc" || sort === "weight_desc" || sort === "strategy_rank") || sort === "name" || sort === "recent" ? sort : "name";
  params.set("sort", allowedSort);
  if (boardOnly) {
    for (const field of ["weightMin", "weightMax"]) {
      const value = form.get(field);
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) params.set(field, value);
    }
  }
  return params;
}

export function parseLibrarySearchParams(
  params: Readonly<Record<string, string | string[] | undefined>>,
): LibraryFilters {
  const many = (name: string) => {
    const value = params[name];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  };
  const media = many("medium").filter(
    (value): value is Medium => value === "board_game" || value === "video_game",
  );
  const sourceCategories = many("category").flatMap((value) => {
    const [kind, sourceCategoryId] = value.split(":");
    return kind && sourceCategoryId ? [{ kind, sourceCategoryId }] : [];
  });
  const number = (name: string) => {
    const value = many(name)[0];
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const sort = many("sort")[0];
  const isBoardOnly = media.length === 1 && media[0] === "board_game";
  const search = many("search")[0]?.trim() || undefined;
  const selectedContributorRoles = contributorRoles.flatMap((role) => {
    const contributorIds = cleanContributorIds(many(`contributor-${role}`));
    return contributorIds.length > 0 ? [{ role, contributorIds }] : [];
  });
  return {
    search,
    media,
    actualPlatforms: cleanSharedNames(many("platform")),
    tags: cleanSharedNames(many("tag")),
    contributorIds: cleanContributorIds(many("contributor")),
    contributorRoles: selectedContributorRoles,
    sourceCategories: clearIncompatibleSourceCategories(media, sourceCategories),
    weightMin: isBoardOnly ? number("weightMin") : undefined,
    weightMax: isBoardOnly ? number("weightMax") : undefined,
    sort: isBoardOnly && ["weight_asc", "weight_desc", "strategy_rank"].includes(sort ?? "")
      ? sort as LibrarySort
      : ["name", "recent"].includes(sort ?? "") ? sort as LibrarySort : "name",
  };
}

export function parseLibraryUrlSearchParams(params: URLSearchParams): LibraryFilters {
  const values: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const entries = params.getAll(key);
    values[key] = entries.length === 1 ? entries[0] : entries;
  }
  return parseLibrarySearchParams(values);
}

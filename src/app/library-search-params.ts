import type { Medium } from "@/modules/games";
import { clearIncompatibleSourceCategories, type LibraryFilters, type LibrarySort } from "@/modules/library";

export function buildLibrarySearchParams(form: FormData): URLSearchParams {
  const media = form.getAll("medium").filter((value): value is string => value === "board_game" || value === "video_game");
  const boardOnly = media.length === 1 && media[0] === "board_game";
  const params = new URLSearchParams();
  for (const medium of media) params.append("medium", medium);
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
  return {
    media,
    sourceCategories: clearIncompatibleSourceCategories(media, sourceCategories),
    weightMin: isBoardOnly ? number("weightMin") : undefined,
    weightMax: isBoardOnly ? number("weightMax") : undefined,
    sort: isBoardOnly && ["weight_asc", "weight_desc", "strategy_rank"].includes(sort ?? "")
      ? sort as LibrarySort
      : ["name", "recent"].includes(sort ?? "") ? sort as LibrarySort : "name",
  };
}

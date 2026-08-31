import type { Medium } from "@/modules/games";
import type { LibraryFilters, LibrarySort } from "@/modules/library";

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
  return {
    query: many("q")[0] ?? "",
    media,
    platforms: many("platform"),
    tags: many("tag"),
    contributors: many("contributor"),
    sourceCategories,
    weightMin: number("weightMin"),
    weightMax: number("weightMax"),
    sort: ["name", "recent", "weight_asc", "weight_desc", "strategy_rank"].includes(sort ?? "")
      ? sort as LibrarySort
      : "name",
  };
}

import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { gameRelationsInAppPrivate, mediaAssetsInAppPrivate, mediaIngestsInAppPrivate } from "./schema";

describe("generated database schema", () => {
  it.each([
    { table: mediaIngestsInAppPrivate, columnName: "game_id", catalogConstraintName: "media_ingests_game_id_fkey", onDelete: "cascade" },
    { table: mediaAssetsInAppPrivate, columnName: "ingest_id", catalogConstraintName: "media_assets_ingest_id_fkey", onDelete: "cascade" },
  ] as const)("keeps $catalogConstraintName exactly once with the catalog delete action", ({ table, columnName, onDelete }) => {
    const matches = getTableConfig(table).foreignKeys.filter((foreignKey) => foreignKey.reference().columns.some((column) => column.name === columnName));

    expect(matches).toHaveLength(1);
    expect(matches[0]?.onDelete).toBe(onDelete);
  });

  it("prevents cascading deletion of either stable relation endpoint", () => {
    const foreignKeys = getTableConfig(gameRelationsInAppPrivate).foreignKeys;
    expect(foreignKeys).toHaveLength(4);
    expect(foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual(["restrict", "restrict", "restrict", "restrict"]);
  });
});

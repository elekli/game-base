import { readFileSync, writeFileSync } from "node:fs";

const schemaPath = "src/adapters/database-schema/schema.ts";
const relationsPath = "src/adapters/database-schema/relations.ts";
const schema = readFileSync(schemaPath, "utf8");
const relations = readFileSync(relationsPath, "utf8");

const emptySchemaOutput = `import { pgTable } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const appPrivate = pgSchema("app_private");`;
const emptyRelationsOutput = `import { relations } from "drizzle-orm/relations";
import {  } from "./schema";`;

if (schema.trim() === emptySchemaOutput) {
  writeFileSync(
    schemaPath,
    `import { pgSchema } from "drizzle-orm/pg-core";

export const appPrivate = pgSchema("app_private");
`,
  );
}

const cyclicMediaReferences = [
  [
    '\tsourceCoverAssetId: uuid("source_cover_asset_id"),',
    '\tsourceCoverAssetId: uuid("source_cover_asset_id").references((): AnyPgColumn => mediaAssetsInAppPrivate.id, { onDelete: "restrict" }),',
  ],
  [
    '\tmanualCoverAssetId: uuid("manual_cover_asset_id"),',
    '\tmanualCoverAssetId: uuid("manual_cover_asset_id").references((): AnyPgColumn => mediaAssetsInAppPrivate.id, { onDelete: "restrict" }),',
  ],
  [
    '\texternalGameIdentityId: uuid("external_game_identity_id"),\n\toriginalObjectPath:',
    '\texternalGameIdentityId: uuid("external_game_identity_id").references((): AnyPgColumn => externalGameIdentitiesInAppPrivate.id, { onDelete: "restrict" }),\n\toriginalObjectPath:',
  ],
  [
    'export const mediaIngestsInAppPrivate = appPrivate.table("media_ingests", {\n\tid: uuid().defaultRandom().notNull(),\n\tgameId: uuid("game_id").notNull(),',
    'export const mediaIngestsInAppPrivate = appPrivate.table("media_ingests", {\n\tid: uuid().defaultRandom().notNull(),\n\tgameId: uuid("game_id").notNull().references((): AnyPgColumn => gamesInAppPrivate.id, { onDelete: "cascade" }),',
  ],
  [
    '\tingestId: uuid("ingest_id").notNull(),\n\tkind:',
    '\tingestId: uuid("ingest_id").notNull().references((): AnyPgColumn => mediaIngestsInAppPrivate.id, { onDelete: "cascade" }),\n\tkind:',
  ],
  [
    '\tcreatedAt: timestamp("created_at", { withTimezone: true, mode: \'string\' }).defaultNow().notNull(),\n\tgameId: uuid("game_id"),\n\tpurpose:',
    '\tcreatedAt: timestamp("created_at", { withTimezone: true, mode: \'string\' }).defaultNow().notNull(),\n\tgameId: uuid("game_id").references((): AnyPgColumn => gamesInAppPrivate.id, { onDelete: "cascade" }),\n\tpurpose:',
  ],
] as const;

let normalizedSchema = schema;
for (const [before, after] of cyclicMediaReferences) normalizedSchema = normalizedSchema.replace(before, after);
for (const [column, reference] of [
  ['gameId: uuid("game_id").notNull()', "gamesInAppPrivate.id"],
  ['ingestId: uuid("ingest_id").notNull()', "mediaIngestsInAppPrivate.id"],
] as const) {
  normalizedSchema = normalizedSchema.replace(
    `${column}.references((): AnyPgColumn => ${reference}, { onDelete: "restrict" })`,
    `${column}.references((): AnyPgColumn => ${reference}, { onDelete: "cascade" })`,
  );
}
normalizedSchema = normalizedSchema.replace(
  'index("media_ingests_finalize_candidates_idx").using("btree", table.state.asc().nullsLast().op("timestamptz_ops"), table.leaseUntil.asc().nullsLast().op("text_ops"))',
  'index("media_ingests_finalize_candidates_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.leaseUntil.asc().nullsLast().op("timestamptz_ops"))',
);
for (const constraintName of [
  "external_game_identities_source_cover_asset_id_fkey",
  "games_manual_cover_asset_id_fkey",
  "media_ingests_external_game_identity_id_fkey",
  "media_ingests_game_id_fkey",
  "media_assets_ingest_id_fkey",
  "media_assets_game_id_fkey",
]) {
  normalizedSchema = normalizedSchema.replace(
    new RegExp(`\\n\\tforeignKey\\(\\{\\n\\t\\t\\tcolumns: \\[[^\\n]+\\],\\n\\t\\t\\tforeignColumns: \\[[^\\n]+\\],\\n\\t\\t\\tname: "${constraintName}"\\n\\t\\t\\}\\)(?:\\.onDelete\\("[^"]+"\\))?,`),
    "",
  );
}
if (normalizedSchema !== schema) writeFileSync(schemaPath, normalizedSchema);

if (relations.trim() === emptyRelationsOutput) {
  writeFileSync(relationsPath, "export {};\n");
}

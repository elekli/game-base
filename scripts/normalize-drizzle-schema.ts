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
    'export const mediaIngestsInAppPrivate = appPrivate.table("media_ingests", {\n\tid: uuid().defaultRandom().notNull(),\n\tgameId: uuid("game_id").notNull(),',
    'export const mediaIngestsInAppPrivate = appPrivate.table("media_ingests", {\n\tid: uuid().defaultRandom().notNull(),\n\tgameId: uuid("game_id").notNull().references((): AnyPgColumn => gamesInAppPrivate.id, { onDelete: "cascade" }),',
  ],
  [
    '\tingestId: uuid("ingest_id").notNull(),\n\tkind:',
    '\tingestId: uuid("ingest_id").notNull().references((): AnyPgColumn => mediaIngestsInAppPrivate.id, { onDelete: "cascade" }),\n\tkind:',
  ],
  [
    '\tderivativeId: uuid("derivative_id").notNull(),\n\tattemptNumber:',
    '\tderivativeId: uuid("derivative_id").notNull().references((): AnyPgColumn => mediaDerivativesInAppPrivate.id, { onDelete: "restrict" }),\n\tattemptNumber:',
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
  /index\("media_ingests_finalize_candidates_idx"\)\.using\("btree", table\.state\.asc\(\)\.nullsLast\(\)\.op\("[^"]+"\), table\.leaseUntil\.asc\(\)\.nullsLast\(\)\.op\("[^"]+"\)\)/,
  'index("media_ingests_finalize_candidates_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.leaseUntil.asc().nullsLast().op("timestamptz_ops"))',
);
normalizedSchema = normalizedSchema.replace(
  /index\("media_derivatives_thumbnail_claim_candidates_idx"\)\.using\("btree", table\.state\.asc\(\)\.nullsLast\(\)\.op\("[^"]+"\), table\.nextAttemptAt\.asc\(\)\.nullsLast\(\)\.op\("[^"]+"\), table\.leaseUntil\.asc\(\)\.nullsLast\(\)\.op\("[^"]+"\)\)/,
  'index("media_derivatives_thumbnail_claim_candidates_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.nextAttemptAt.asc().nullsLast().op("timestamptz_ops"), table.leaseUntil.asc().nullsLast().op("timestamptz_ops"))',
);
for (const constraintName of [
  "media_ingests_game_id_fkey",
  "media_assets_ingest_id_fkey",
  "media_derivative_attempts_derivative_id_fkey",
]) {
  normalizedSchema = normalizedSchema.replace(
    new RegExp(`\\n\\tforeignKey\\(\\{\\n\\t\\t\\tcolumns: \\[[^\\n]+\\],\\n\\t\\t\\tforeignColumns: \\[[^\\n]+\\],\\n\\t\\t\\tname: "${constraintName}"\\n\\t\\t\\}\\)(?:\\.onDelete\\("[^"]+"\\))?,`),
    "",
  );
}
if (normalizedSchema.includes("AnyPgColumn") && !normalizedSchema.includes("type AnyPgColumn")) {
  normalizedSchema = normalizedSchema.replace("import { pgTable,", "import { pgTable, type AnyPgColumn,");
}
if (normalizedSchema !== schema) writeFileSync(schemaPath, normalizedSchema);

if (relations.trim() === emptyRelationsOutput) {
  writeFileSync(relationsPath, "export {};\n");
}

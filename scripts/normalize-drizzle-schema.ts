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

if (relations.trim() === emptyRelationsOutput) {
  writeFileSync(relationsPath, "export {};\n");
}

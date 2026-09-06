import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;

if (!directDatabaseUrl) {
  throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");
}

const scratchRoot = join(process.cwd(), ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratchDirectory = mkdtempSync(join(scratchRoot, "drizzle-pull-"));
const installedCliPath = join(process.cwd(), "node_modules/drizzle-kit/bin.cjs");
const instrumentedCliPath = join(scratchDirectory, "drizzle-kit.cjs");
const tableQuery =
  "const tableResponse = await getColumnsInfoQuery({ schema: tableSchema, table: tableName, db });";
const delayedTableQuery = `await new Promise((resolve) => setTimeout(resolve, tableName === process.env.DRIZZLE_TEST_DELAY_TABLE ? 250 : 0));
            ${tableQuery}`;

function pullWithDelayedTable(tableName: string, outputName: string) {
  const outputDirectory = join(scratchDirectory, outputName);
  const configPath = join(scratchDirectory, `${outputName}.config.ts`);

  writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      dialect: "postgresql",
      dbCredentials: { url: directDatabaseUrl },
      out: outputDirectory,
      schemaFilter: ["app_private"],
    })};\n`,
  );

  execFileSync(process.execPath, [instrumentedCliPath, "pull", "--config", configPath], {
    env: { ...process.env, DRIZZLE_TEST_DELAY_TABLE: tableName },
    stdio: "pipe",
  });

  return {
    schema: readFileSync(join(outputDirectory, "schema.ts"), "utf8"),
    relations: readFileSync(join(outputDirectory, "relations.ts"), "utf8"),
  };
}

describe("Drizzle PostgreSQL introspection ordering", () => {
  beforeAll(() => {
    const cli = readFileSync(installedCliPath, "utf8");
    const occurrences = cli.split(tableQuery).length - 1;
    expect(occurrences).toBe(1);
    writeFileSync(instrumentedCliPath, cli.replace(tableQuery, delayedTableQuery));
  });

  afterAll(() => {
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  it("generates identical files when table queries complete in different orders", () => {
    const gamesDelayed = pullWithDelayedTable("games", "games-delayed");
    const identitiesDelayed = pullWithDelayedTable(
      "external_game_identities",
      "identities-delayed",
    );

    expect(identitiesDelayed).toEqual(gamesDelayed);
  });
});

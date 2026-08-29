import { defineConfig } from "drizzle-kit";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;
if (directDatabaseUrl === undefined) {
  throw new Error("DIRECT_DATABASE_URL is required for schema introspection.");
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: directDatabaseUrl },
  out: "./src/adapters/database-schema",
});


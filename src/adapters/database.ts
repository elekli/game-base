import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 5,
    prepare: false,
  });

  return {
    db: drizzle(client),
    close: () => client.end(),
  };
}


import "server-only";

import { createDatabase } from "@/adapters/database";
import { ProductionProductCanaryAdapter } from "@/adapters/production-product-canary-adapter";

const database = process.env.DATABASE_URL?.startsWith("postgres")
  ? createDatabase(process.env.DATABASE_URL)
  : null;

const unavailable = new Proxy({}, {
  get: () => async () => { throw new Error("production product canary database is unavailable"); },
}) as ProductionProductCanaryAdapter;

export const productionProductCanary = database
  ? new ProductionProductCanaryAdapter(database.db)
  : unavailable;

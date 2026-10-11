import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { productionProductCanaryCommandContext } from "@/shared/production-canary/command-context";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 5,
    prepare: false,
  });

  const base = drizzle(client);
  const db = new Proxy(base, {
    get(target, property) {
      if (property !== "transaction") return Reflect.get(target, property, target);
      const transaction = target.transaction.bind(target);
      return (...args: unknown[]) => {
        const callback = args[0] as (tx: unknown) => Promise<unknown>;
        return Reflect.apply(transaction, target, [async (tx: unknown) => {
          const command = productionProductCanaryCommandContext.getStore();
          if (command) {
            await (tx as { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }).execute(sql`
              select app_private.guard_production_product_canary_command(
                ${command.generation}::uuid, ${command.ownerId}, ${command.commandId}::uuid,
                ${command.operation}, ${command.targetIds}::uuid[]
              )
            `);
          }
          return callback(tx);
        }, ...args.slice(1)]);
      };
    },
  }) as typeof base;
  return {
    db,
    close: () => client.end(),
  };
}

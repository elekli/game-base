import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type ProductionProductCanaryCommand = Readonly<{
  generation: string;
  ownerId: string;
  commandId: string;
  operation: string;
  targetIds: readonly string[];
}>;

export const productionProductCanaryCommandContext =
  new AsyncLocalStorage<ProductionProductCanaryCommand>();

export function runProductionProductCanaryCommand<Value>(
  command: ProductionProductCanaryCommand,
  execute: () => Promise<Value>,
) {
  return productionProductCanaryCommandContext.run(command, execute);
}

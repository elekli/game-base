import "server-only";

import { headers } from "next/headers";
import { productionProductCanary } from "./service";
import { productionCanaryGenerationFromCookie } from "./owner-mutation";

export async function productionCanaryPageFixtures(ownerId: string) {
  const generation = productionCanaryGenerationFromCookie(await headers());
  if (!generation) return [] as const;
  return productionProductCanary.gamesForOwner(generation, ownerId);
}

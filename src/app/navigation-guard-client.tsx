"use client";

import { installHistoryTracking } from "@/app/games/[gameId]/notes-client";

if (typeof window !== "undefined") installHistoryTracking();

export function NavigationGuardClient() {
  return null;
}

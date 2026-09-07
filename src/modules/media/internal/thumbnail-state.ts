export const THUMBNAIL_MAX_AUTOMATIC_ATTEMPTS = 3;

export function thumbnailBackoff(cycleAttemptCount: number): number | null {
  return ([1_000, 5_000, null] as const)[cycleAttemptCount - 1] ?? null;
}

export function decideThumbnailFailure(input: Readonly<{ cycleAttemptCount: number; deterministic: boolean }>): Readonly<{
  state: "pending" | "failed";
  retryDelayMs: number | null;
}> {
  if (input.deterministic) return { state: "failed", retryDelayMs: null };
  const retryDelayMs = thumbnailBackoff(input.cycleAttemptCount);
  return retryDelayMs === null ? { state: "failed", retryDelayMs: null } : { state: "pending", retryDelayMs };
}

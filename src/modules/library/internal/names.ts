export function normalizeSharedName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function cleanSharedNames(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const displayName = value.trim();
    const key = normalizeSharedName(displayName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(displayName);
  }
  return result;
}

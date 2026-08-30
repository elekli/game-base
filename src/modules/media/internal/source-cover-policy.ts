const ALLOWED_HOSTS = new Set(["images.unsplash.com", "images.igdb.com", "cf.geekdo-images.com"]);

export function isAllowedSourceCoverUrl(sourceUrl: string): boolean {
  try { const parsed = new URL(sourceUrl); return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname); }
  catch { return false; }
}

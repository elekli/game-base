import {
  SourceAuthenticationFailedError,
  SourceNotFoundError,
  SourceRateLimitedError,
  SourceResponseInvalidError,
  SourceUnavailableError,
} from "@/modules/games/internal/errors";
import { assertReference, normalizeSourceId, validateSnapshot } from "@/modules/games/internal/source-snapshot";
import type { ExternalGameRef, NormalizedSearchCandidate, SourceCatalogPort, SourceSearchQuery, SourceSnapshot } from "@/modules/games/internal/types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (match?.[1]) return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return xml.match(new RegExp(`<${name}[^>]*\\bvalue=["']([^"']+)["'][^>]*/>`, "i"))?.[1]?.trim() ?? null;
}
function attr(xml: string, tagName: string, attribute: string): string | null {
  return xml.match(new RegExp(`<${tagName}[^>]*\\b${attribute}=["']([^"']+)["']`, "i"))?.[1] ?? null;
}
function year(value: string | null): number | null { const n = value ? Number(value) : NaN; return Number.isInteger(n) && n >= 1800 && n <= 2200 ? n : null; }
function positive(value: string | null): number | null { const n = value ? Number(value) : NaN; return Number.isInteger(n) && n >= 1 ? n : null; }
function nameValue(attributes: string): string | null { return attributes.match(/\bvalue=["']([^"']+)["']/i)?.[1]?.trim() ?? null; }
function primaryName(xml: string): string | null {
  const names = [...xml.matchAll(/<name\b([^>]*)>/gi)];
  const primary = names.find((match) => /\btype=["']primary["']/i.test(match[1]));
  return (primary ? nameValue(primary[1]) : null) ?? (names[0] ? nameValue(names[0][1]) : null);
}

function links(xml: string, types: readonly string[]) {
  const allowed = new Set(types);
  return [...xml.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)].flatMap((match) => {
    const type = match[1].match(/\btype=["']([^"']+)["']/i)?.[1];
    const id = match[1].match(/\bid=["']([^"']+)["']/i)?.[1];
    const name = match[1].match(/\bvalue=["']([^"']+)["']/i)?.[1]?.trim();
    return type && id && name && allowed.has(type) ? [{ type, id, name }] : [];
  });
}

function numberAttribute(xml: string, element: string, attribute: string): number | null {
  const value = attr(xml, element, attribute);
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBggSearchXml(xml: string): readonly NormalizedSearchCandidate[] {
  if (!/<items\b/i.test(xml)) throw new SourceResponseInvalidError();
  return [...xml.matchAll(/<item\b[^>]*id=["'](\d+)["'][^>]*>([\s\S]*?)<\/item>/gi)].map((match) => ({
    ref: { provider: "bgg" as const, medium: "board_game" as const, sourceId: normalizeSourceId(match[1]) },
    title: tag(match[2], "name") ?? "",
    releaseYear: year(attr(match[2], "yearpublished", "value")),
    coverPreviewUrl: null,
  })).filter((item) => item.title.length > 0);
}

export function parseBggThingXml(xml: string, sourceId: string): SourceSnapshot {
  const title = primaryName(xml) ?? tag(xml, "name");
  if (!title) throw new SourceResponseInvalidError();
  const ref = { provider: "bgg" as const, medium: "board_game" as const, sourceId };
  const minPlayers = positive(attr(xml, "minplayers", "value"));
  const maxPlayers = positive(attr(xml, "maxplayers", "value"));
  const categoryLinks = links(xml, ["boardgamecategory", "boardgamemechanic"]);
  const contributorLinks = links(xml, ["boardgamedesigner", "boardgameartist", "boardgamepublisher"]);
  const rank = xml.match(/<rank\b[^>]*type=["']strategygames["'][^>]*rank=["'](\d+)["']/i)?.[1];
  const names = [...xml.matchAll(/<name\b([^>]*)\/?>(?:<\/name>)?/gi)].flatMap((match) => {
    const type = match[1].match(/\btype=["']([^"']+)["']/i)?.[1];
    return type === "alternate" ? [nameValue(match[1]) ?? ""] : [];
  }).filter(Boolean);
  return validateSnapshot({
    ref,
    canonicalUrl: `https://boardgamegeek.com/boardgame/${sourceId}`,
    title,
    localizedTitle: null,
    aliases: names,
    description: tag(xml, "description"),
    releaseYear: year(attr(xml, "yearpublished", "value")),
    coverUrl: tag(xml, "image"),
    categories: categoryLinks.map((item) => ({ kind: item.type === "boardgamecategory" ? "category" : "mechanic", sourceCategoryId: item.id, name: item.name })),
    contributors: contributorLinks.map((item) => ({ sourceContributorId: item.id, name: item.name, entityKind: item.type === "boardgamepublisher" ? "company" as const : "person" as const, role: item.type === "boardgamedesigner" ? "design" as const : item.type === "boardgameartist" ? "art" as const : "publisher" as const })),
    minPlayers: minPlayers ?? maxPlayers,
    maxPlayers: maxPlayers ?? minPlayers, supportsSolo: "unknown",
    playtimeMinutes: numberAttribute(xml, "playingtime", "value"), weight: numberAttribute(xml, "averageweight", "value"), strategyRank: rank ? Number(rank) : null, supportedPlatforms: [],
  });
}

export class BggCatalogAdapter implements SourceCatalogPort {
  constructor(private readonly options: Readonly<{ token?: string; fetchImpl?: FetchLike; baseUrl?: string }> = {}) {}
  private get fetchImpl(): FetchLike { return this.options.fetchImpl ?? fetch; }
  async search(input: SourceSearchQuery): Promise<readonly NormalizedSearchCandidate[]> {
    if (!input.query.trim()) throw new SourceResponseInvalidError();
    const response = await this.request(`/search.xml?type=boardgame&query=${encodeURIComponent(input.query.trim())}`);
    return parseBggSearchXml(await response.text());
  }
  async fetchSnapshot(ref: ExternalGameRef, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<SourceSnapshot> {
    const normalized = assertReference(ref);
    const response = await this.request(`/thing.xml?id=${normalized.sourceId}&stats=1`, freshness);
    return parseBggThingXml(await response.text(), normalized.sourceId);
  }
  private async request(path: string, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<Response> {
    if (!this.options.token) throw new SourceAuthenticationFailedError();
    let response: Response;
    try { response = await this.fetchImpl(`${this.options.baseUrl ?? "https://boardgamegeek.com/xmlapi2"}${path}`, { cache: freshness === "fresh" ? "no-store" : "default", headers: { Authorization: `Bearer ${this.options.token}` } }); }
    catch { throw new SourceUnavailableError(); }
    if (response.status === 401 || response.status === 403) throw new SourceAuthenticationFailedError();
    if (response.status === 404) throw new SourceNotFoundError();
    if (response.status === 429) { const retryAfter = Number(response.headers.get("retry-after")); throw new SourceRateLimitedError(Number.isFinite(retryAfter) ? retryAfter : null); }
    if (!response.ok) throw new SourceUnavailableError();
    return response;
  }
}

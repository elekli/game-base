import {
  SourceAuthenticationFailedError,
  SourceAuthenticationUnavailableError,
  SourceNotFoundError,
  SourceRateLimitedError,
  SourceResponseInvalidError,
  SourceUnavailableError,
} from "@/modules/games/internal/errors";
import { assertReference, validateSnapshot } from "@/modules/games/internal/source-snapshot";
import type { ExternalGameRef, NormalizedSearchCandidate, SourceCatalogPort, SourceSearchQuery, SourceSnapshot } from "@/modules/games/internal/types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type IgdbGame = Readonly<{ id: number; name: string; first_release_date?: number; cover?: { url?: string }; summary?: string; platforms?: readonly { name?: string }[]; genres?: readonly { id?: number; name?: string }[]; themes?: readonly { id?: number; name?: string }[] }>;

export function parseIgdbGamesJson(payload: unknown): readonly NormalizedSearchCandidate[] {
  if (!Array.isArray(payload)) throw new SourceResponseInvalidError();
  return payload.map((raw) => {
    if (!raw || typeof raw !== "object" || typeof (raw as IgdbGame).id !== "number" || typeof (raw as IgdbGame).name !== "string") throw new SourceResponseInvalidError();
    const game = raw as IgdbGame;
    return { ref: { provider: "igdb" as const, medium: "video_game" as const, sourceId: String(game.id) }, title: game.name.trim(), releaseYear: game.first_release_date ? new Date(game.first_release_date * 1000).getUTCFullYear() : null, coverPreviewUrl: game.cover?.url?.startsWith("//") ? `https:${game.cover.url}` : game.cover?.url ?? null };
  }).filter((item) => item.title.length > 0);
}

export function parseIgdbSnapshot(raw: unknown, sourceId: string): SourceSnapshot {
  const candidates = parseIgdbGamesJson([raw]);
  if (candidates.length === 0) throw new SourceResponseInvalidError();
  const game = raw as IgdbGame;
  const candidate = candidates[0];
  const categories = [
    ...(game.genres ?? []).filter((item) => typeof item.id === "number" && typeof item.name === "string").map((item) => ({ kind: "genre", sourceCategoryId: String(item.id), name: item.name as string })),
    ...(game.themes ?? []).filter((item) => typeof item.id === "number" && typeof item.name === "string").map((item) => ({ kind: "theme", sourceCategoryId: String(item.id), name: item.name as string })),
  ];
  return validateSnapshot({ ref: { provider: "igdb", medium: "video_game", sourceId }, canonicalUrl: `https://www.igdb.com/games/${sourceId}`, title: candidate.title, localizedTitle: null, aliases: [], description: game.summary ?? null, releaseYear: candidate.releaseYear, coverUrl: candidate.coverPreviewUrl, categories, contributors: [], minPlayers: null, maxPlayers: null, supportsSolo: "unknown", playtimeMinutes: null, weight: null, strategyRank: null, supportedPlatforms: (game.platforms ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)) });
}

export class IgdbCatalogAdapter implements SourceCatalogPort {
  private token: Readonly<{ value: string; expiresAt: number }> | null = null;
  private tokenPromise: Promise<string> | null = null;
  constructor(private readonly options: Readonly<{ clientId?: string; clientSecret?: string; fetchImpl?: FetchLike; tokenUrl?: string; apiUrl?: string }> = {}) {}
  private get fetchImpl(): FetchLike { return this.options.fetchImpl ?? fetch; }
  async search(input: SourceSearchQuery): Promise<readonly NormalizedSearchCandidate[]> {
    if (!input.query.trim()) throw new SourceResponseInvalidError();
    const escaped = input.query.trim().replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replace(/[\u0000-\u001f]/g, " ").slice(0, 120);
    const response = await this.call("games", `fields id,name,first_release_date,cover.url; search \"${escaped}\"; limit ${Math.min(input.limit ?? 20, 50)};`);
    return parseIgdbGamesJson(await response.json());
  }
  async fetchSnapshot(ref: ExternalGameRef, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<SourceSnapshot> {
    const normalized = assertReference(ref);
    const response = await this.call("games", `fields id,name,first_release_date,cover.url,summary,platforms.name,genres.id,genres.name,themes.id,themes.name; where id = ${normalized.sourceId}; limit 1;`, freshness);
    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) throw new SourceNotFoundError();
    return parseIgdbSnapshot(payload[0], normalized.sourceId);
  }
  private async call(path: string, query: string, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<Response> {
    const token = await this.getToken();
    let response: Response;
    try { response = await this.fetchImpl(`${this.options.apiUrl ?? "https://api.igdb.com/v4"}/${path}`, { cache: freshness === "fresh" ? "no-store" : "default", method: "POST", headers: { "Client-ID": this.options.clientId ?? "", Authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: query }); }
    catch { throw new SourceUnavailableError(); }
    if (response.status === 401) { this.token = null; const retry = await this.getToken(true); return this.callWithToken(path, query, retry, freshness); }
    if (response.status === 429) { const retryAfter = Number(response.headers.get("retry-after")); throw new SourceRateLimitedError(Number.isFinite(retryAfter) ? retryAfter : null); }
    if (!response.ok) throw new SourceUnavailableError();
    return response;
  }
  private async callWithToken(path: string, query: string, token: string, freshness: "cache_ok" | "fresh" = "cache_ok"): Promise<Response> {
    let response: Response;
    try { response = await this.fetchImpl(`${this.options.apiUrl ?? "https://api.igdb.com/v4"}/${path}`, { cache: freshness === "fresh" ? "no-store" : "default", method: "POST", headers: { "Client-ID": this.options.clientId ?? "", Authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: query }); }
    catch { throw new SourceUnavailableError(); }
    if (response.status === 401) throw new SourceAuthenticationFailedError();
    if (response.status === 429) { const retryAfter = Number(response.headers.get("retry-after")); throw new SourceRateLimitedError(Number.isFinite(retryAfter) ? retryAfter : null); }
    if (!response.ok) throw new SourceUnavailableError();
    return response;
  }
  private async getToken(force = false): Promise<string> {
    if (!this.options.clientId || !this.options.clientSecret) throw new SourceAuthenticationFailedError();
    if (!force && this.token && this.token.expiresAt > Date.now() + 300_000) return this.token.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      let response: Response;
      try { response = await this.fetchImpl(this.options.tokenUrl ?? "https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.options.clientId as string, client_secret: this.options.clientSecret as string, grant_type: "client_credentials" }) }); }
      catch { throw new SourceAuthenticationUnavailableError(); }
      if (!response.ok) throw response.status === 401 || response.status === 403 ? new SourceAuthenticationFailedError() : new SourceAuthenticationUnavailableError();
      const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") throw new SourceResponseInvalidError();
      this.token = { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
      return payload.access_token;
    })();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }
}

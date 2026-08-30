import {
  SourceContentChangedError,
  SourceIdentityConflictError,
  SourceNotLinkedError,
  SourceQueryInvalidError,
} from "./internal/errors";
import { confirmationFingerprint } from "./internal/confirmation-fingerprint";
import { InMemoryGameStore, type GameStore } from "./internal/store";
import type {
  Confirmation,
  CreateGameResult,
  ExternalGameRef,
  GameRecord,
  Medium,
  NormalizedSearchCandidate,
  Provider,
  SourceCatalogPort,
} from "./internal/types";

export type GamesService = Readonly<{
  searchExternalGames(input: Readonly<{ query: string }>): Promise<Readonly<{ groups: readonly { provider: Provider; items: readonly NormalizedSearchCandidate[]; errorCode: string | null }[] }>>;
  getExternalGameConfirmation(input: Readonly<{ ref: ExternalGameRef }>): Promise<Confirmation>;
  createGameFromExternalSource(input: Readonly<{ ref: ExternalGameRef; confirmationFingerprint: string }>): Promise<CreateGameResult>;
  linkExternalSource(input: Readonly<{ gameId: string; ref: ExternalGameRef; confirmationFingerprint: string }>): Promise<GameRecord>;
  refreshExternalMetadata(input: Readonly<{ gameId: string }>): Promise<GameRecord>;
  createManualGame(input: Readonly<{ displayName: string; medium: Medium }>): Promise<GameRecord>;
  listGames(query?: string): Promise<readonly GameRecord[]>;
  getGame(id: string): Promise<GameRecord | null>;
}>;

export function createGamesService(catalogs: Readonly<Record<Provider, SourceCatalogPort>>, store: GameStore = new InMemoryGameStore()): GamesService {
  return {
    async searchExternalGames({ query }) {
      if (!query.trim() || query.trim().length > 120) throw new SourceQueryInvalidError();
      const results = await Promise.all(["bgg", "igdb"].map(async (provider) => {
        try { return { provider: provider as Provider, items: await catalogs[provider as Provider].search({ provider: provider as Provider, query, limit: 20 }), errorCode: null }; }
        catch (error) { return { provider: provider as Provider, items: [], errorCode: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "source_unavailable" }; }
      }));
      return { groups: results };
    },
    async getExternalGameConfirmation({ ref }) {
      const snapshot = await catalogs[ref.provider].fetchSnapshot(ref, "cache_ok");
      return { candidate: { ref, title: snapshot.title, releaseYear: snapshot.releaseYear, coverPreviewUrl: snapshot.coverUrl }, snapshot, fingerprint: confirmationFingerprint(snapshot) };
    },
    async createGameFromExternalSource({ ref, confirmationFingerprint: expected }) {
      const snapshot = await catalogs[ref.provider].fetchSnapshot(ref, "fresh");
      const actual = confirmationFingerprint(snapshot);
      if (actual !== expected) throw new SourceContentChangedError({ candidate: { ref, title: snapshot.title, releaseYear: snapshot.releaseYear, coverPreviewUrl: snapshot.coverUrl }, snapshot, fingerprint: actual });
      try {
        const result = await store.createFromSource(ref, snapshot);
        return { ...result, identityConflict: null };
      } catch (error) {
        if (error instanceof SourceIdentityConflictError) {
          const game = await store.get(error.gameId);
          if (!game) throw error;
          return { game, created: false, identityConflict: error.trashed ? "trashed" : "active" };
        }
        throw error;
      }
    },
    async linkExternalSource({ gameId, ref, confirmationFingerprint: expected }) {
      const snapshot = await catalogs[ref.provider].fetchSnapshot(ref, "fresh");
      const actual = confirmationFingerprint(snapshot);
      if (actual !== expected) throw new SourceContentChangedError({ candidate: { ref, title: snapshot.title, releaseYear: snapshot.releaseYear, coverPreviewUrl: snapshot.coverUrl }, snapshot, fingerprint: actual });
      return store.linkFromSource(gameId, ref, snapshot);
    },
    async refreshExternalMetadata({ gameId }) {
      const game = await store.get(gameId);
      if (!game?.snapshot) throw new SourceNotLinkedError();
      const snapshot = await catalogs[game.snapshot.ref.provider].fetchSnapshot(game.snapshot.ref, "fresh");
      return store.refreshSource(gameId, snapshot);
    },
    async createManualGame(input) { return store.createManual(input.displayName, input.medium); },
    async listGames(query) { return store.list(query); },
    async getGame(id) { return store.get(id); },
  };
}

export * from "./internal/errors";
export * from "./internal/confirmation-fingerprint";
export * from "./internal/source-snapshot";
export * from "./internal/source-description";
export * from "./internal/types";
export * from "./internal/store";

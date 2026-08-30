import { randomUUID } from "node:crypto";
import { SourceIdentityConflictError } from "./errors";
import type { ExternalGameRef, GameRecord, SourceSnapshot } from "./types";

export type GameStore = {
  list(query?: string): Promise<readonly GameRecord[]>;
  get(id: string): Promise<GameRecord | null>;
  createManual(displayName: string, medium: GameRecord["medium"]): Promise<GameRecord>;
  createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }>;
  trash(id: string): Promise<void>;
};

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, GameRecord>();
  private readonly identities = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();

  async list(query = ""): Promise<readonly GameRecord[]> {
    const normalized = query.trim().toLocaleLowerCase();
    return [...this.games.values()]
      .filter((game) => game.trashedAt === null && (!normalized || game.displayName.toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hant"));
  }
  async get(id: string) { return this.games.get(id) ?? null; }
  async createManual(displayName: string, medium: GameRecord["medium"]): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const now = new Date().toISOString();
    const game: GameRecord = { id: randomUUID(), medium, displayName: title, trashedAt: null, externalIdentityId: null, snapshot: null, createdAt: now };
    this.games.set(game.id, game);
    return game;
  }
  async createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }> {
    const key = `${ref.provider}:${ref.sourceId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.locks.set(key, lock);
    await previous;
    try {
      const existingId = this.identities.get(key);
      if (existingId) {
        const existing = this.games.get(existingId);
        if (existing) {
          throw new SourceIdentityConflictError(existing.id, existing.trashedAt !== null);
        }
      }
      const game: GameRecord = { id: randomUUID(), medium: ref.medium, displayName: snapshot.title, trashedAt: null, externalIdentityId: randomUUID(), snapshot, createdAt: new Date().toISOString() };
      this.games.set(game.id, game);
      this.identities.set(key, game.id);
      return { game, created: true };
    } finally {
      release();
      if (this.locks.get(key) === lock) this.locks.delete(key);
    }
  }
  async trash(id: string) {
    const game = this.games.get(id);
    if (!game) return;
    this.games.set(id, { ...game, trashedAt: new Date().toISOString() });
  }
}

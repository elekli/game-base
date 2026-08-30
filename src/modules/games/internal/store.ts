import { randomUUID } from "node:crypto";
import { SourceIdentityConflictError, SourceMediumMismatchError, SourcePersistenceFailedError } from "./errors";
import type { ExternalGameRef, GameContribution, GameRecord, Medium, SourceSnapshot } from "./types";

export type GameEditInput = Readonly<{
  displayName?: string | null;
  actualPlatforms?: readonly string[];
  tags?: readonly string[];
  playerCountNote?: string | null;
}>;

export type ManualContributionInput = Readonly<{
  gameId: string;
  name: string;
  entityKind: "person" | "company";
  role: Extract<GameContribution["role"], "design" | "art" | "publisher">;
}>;

export type ManualContributionResult = Readonly<{ game: GameRecord; possibleDuplicate: boolean }>;

export type GameStore = {
  list(query?: string): Promise<readonly GameRecord[]>;
  get(id: string): Promise<GameRecord | null>;
  createManual(displayName: string, medium: Medium): Promise<GameRecord>;
  createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }>;
  linkFromSource(gameId: string, ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<GameRecord>;
  refreshSource(gameId: string, snapshot: SourceSnapshot): Promise<GameRecord>;
  edit(gameId: string, input: GameEditInput): Promise<GameRecord>;
  addManualContribution(input: ManualContributionInput): Promise<ManualContributionResult>;
  removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord>;
  deletePlatform(name: string): Promise<void>;
  deleteTag(name: string): Promise<void>;
  trash(id: string): Promise<void>;
};

function sourceNames(snapshot: SourceSnapshot): readonly string[] {
  return [snapshot.title, snapshot.localizedTitle ?? "", ...snapshot.aliases].map((value) => value.trim()).filter(Boolean);
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase("en-US"); }

function uniqueNames(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const keys = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalize(trimmed);
    if (key && !keys.has(key)) { keys.add(key); result.push(trimmed); }
  }
  return result;
}

function sourceContributions(snapshot: SourceSnapshot): readonly GameContribution[] {
  return snapshot.contributors.map((contributor) => ({
    id: `source:${snapshot.ref.provider}:${contributor.sourceContributorId}`,
    name: contributor.name,
    entityKind: contributor.entityKind,
    role: contributor.role,
    origin: "source" as const,
    provider: snapshot.ref.provider,
    sourceContributorId: contributor.sourceContributorId,
  }));
}

function applySnapshot(game: GameRecord, snapshot: SourceSnapshot): GameRecord {
  const nextName = game.customDisplayName ?? snapshot.title;
  return {
    ...game,
    displayName: nextName,
    sourceNames: sourceNames(snapshot),
    aliases: snapshot.aliases,
    snapshot,
    contributors: [...sourceContributions(snapshot), ...game.contributors.filter((contributor) => contributor.origin === "manual")],
  };
}

function assertVideoGamePlatforms(medium: Medium, platforms: readonly string[]) {
  if (medium === "board_game" && platforms.length > 0) throw new Error("桌遊不可設定實際平台。");
}

const SYSTEM_PLATFORMS = new Set(["steam", "ps5", "xbox series", "nintendo switch"]);

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, GameRecord>();
  private readonly identities = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();

  async list(query = ""): Promise<readonly GameRecord[]> {
    const normalized = query.trim().toLocaleLowerCase("en-US");
    return [...this.games.values()]
      .filter((game) => game.trashedAt === null && (!normalized || [game.displayName, ...game.sourceNames, ...game.aliases].some((name) => name.toLocaleLowerCase("en-US").includes(normalized))))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hant"));
  }

  async get(id: string) { return this.games.get(id) ?? null; }

  async createManual(displayName: string, medium: Medium): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const game: GameRecord = { id: randomUUID(), medium, displayName: title, customDisplayName: title, sourceNames: [], aliases: [], actualPlatforms: [], tags: [], contributors: [], playerCountNote: null, coverIngestState: null, trashedAt: null, externalIdentityId: null, snapshot: null, createdAt: new Date().toISOString() };
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
        if (existing) throw new SourceIdentityConflictError(existing.id, existing.trashedAt !== null);
      }
      const game: GameRecord = { id: randomUUID(), medium: ref.medium, displayName: snapshot.title, customDisplayName: null, sourceNames: sourceNames(snapshot), aliases: snapshot.aliases, actualPlatforms: [], tags: [], contributors: sourceContributions(snapshot), playerCountNote: null, coverIngestState: null, trashedAt: null, externalIdentityId: randomUUID(), snapshot, createdAt: new Date().toISOString() };
      this.games.set(game.id, game);
      this.identities.set(key, game.id);
      return { game, created: true };
    } finally {
      release();
      if (this.locks.get(key) === lock) this.locks.delete(key);
    }
  }

  async linkFromSource(gameId: string, ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<GameRecord> {
    const game = this.games.get(gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    if (game.externalIdentityId) throw new Error("遊戲已連結來源。");
    if (game.medium !== ref.medium) throw new SourceMediumMismatchError();
    const existingId = this.identities.get(`${ref.provider}:${ref.sourceId}`);
    if (existingId) {
      const existing = this.games.get(existingId);
      if (existing) throw new SourceIdentityConflictError(existing.id, existing.trashedAt !== null);
    }
    const linked = { ...game, displayName: game.customDisplayName ?? snapshot.title, sourceNames: sourceNames(snapshot), aliases: snapshot.aliases, externalIdentityId: randomUUID(), snapshot, contributors: [...sourceContributions(snapshot), ...game.contributors.filter((contributor) => contributor.origin === "manual")] };
    this.games.set(gameId, linked);
    this.identities.set(`${ref.provider}:${ref.sourceId}`, gameId);
    return linked;
  }

  async refreshSource(gameId: string, snapshot: SourceSnapshot): Promise<GameRecord> {
    const game = this.games.get(gameId);
    if (!game || !game.externalIdentityId) throw new Error("遊戲尚未連結來源。");
    const refreshed = applySnapshot(game, snapshot);
    this.games.set(gameId, refreshed);
    return refreshed;
  }

  async edit(gameId: string, input: GameEditInput): Promise<GameRecord> {
    const game = this.games.get(gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    const actualPlatforms = input.actualPlatforms === undefined ? game.actualPlatforms : uniqueNames(input.actualPlatforms);
    assertVideoGamePlatforms(game.medium, actualPlatforms);
    const tags = input.tags === undefined ? game.tags : uniqueNames(input.tags);
    const customDisplayName = input.displayName === undefined ? game.customDisplayName : input.displayName === null ? null : input.displayName.trim() || null;
    const updated = { ...game, customDisplayName, displayName: customDisplayName ?? game.snapshot?.title ?? game.sourceNames[0] ?? game.displayName, actualPlatforms, tags, playerCountNote: input.playerCountNote === undefined ? game.playerCountNote : input.playerCountNote?.trim() || null };
    this.games.set(gameId, updated);
    return updated;
  }

  async addManualContribution(input: ManualContributionInput): Promise<ManualContributionResult> {
    const game = this.games.get(input.gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    const name = input.name.trim();
    if (!name) throw new Error("貢獻者名稱不可為空。");
    const possibleDuplicate = [...this.games.values()].some((item) => item.contributors.some((contributor) => contributor.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")));
    const contribution: GameContribution = { id: randomUUID(), name, entityKind: input.entityKind, role: input.role, origin: "manual", provider: null, sourceContributorId: null };
    const updated = { ...game, contributors: [...game.contributors, contribution] };
    this.games.set(game.id, updated);
    return { game: updated, possibleDuplicate };
  }

  async removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord> {
    const game = this.games.get(gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    const updated = { ...game, contributors: game.contributors.filter((contribution) => contribution.id !== contributionId || contribution.origin !== "manual") };
    this.games.set(game.id, updated);
    return updated;
  }

  async deletePlatform(name: string): Promise<void> {
    const key = normalize(name);
    if (SYSTEM_PLATFORMS.has(key)) throw new Error("系統預設平台不可刪除。");
    if ([...this.games.values()].some((game) => game.actualPlatforms.some((platform) => normalize(platform) === key))) throw new Error("仍有遊戲使用此平台，請先移除關係。");
  }

  async deleteTag(name: string): Promise<void> {
    const key = normalize(name);
    if ([...this.games.values()].some((game) => game.tags.some((tag) => normalize(tag) === key))) throw new Error("仍有遊戲使用此標籤，請先移除關係。");
  }

  async trash(id: string) {
    const game = this.games.get(id);
    if (game) this.games.set(id, { ...game, trashedAt: new Date().toISOString() });
  }
}

export class UnavailableGameStore implements GameStore {
  private fail(): never { throw new SourcePersistenceFailedError(); }
  async list(): Promise<readonly GameRecord[]> { return this.fail(); }
  async get(): Promise<GameRecord | null> { return this.fail(); }
  async createManual(): Promise<GameRecord> { return this.fail(); }
  async createFromSource(): Promise<{ game: GameRecord; created: boolean }> { return this.fail(); }
  async linkFromSource(): Promise<GameRecord> { return this.fail(); }
  async refreshSource(): Promise<GameRecord> { return this.fail(); }
  async edit(): Promise<GameRecord> { return this.fail(); }
  async addManualContribution(): Promise<ManualContributionResult> { return this.fail(); }
  async removeManualContribution(): Promise<GameRecord> { return this.fail(); }
  async deletePlatform(): Promise<void> { this.fail(); }
  async deleteTag(): Promise<void> { this.fail(); }
  async trash(): Promise<void> { this.fail(); }
}

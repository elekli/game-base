import { randomUUID } from "node:crypto";
import { SourceGameUnavailableError, SourceIdentityConflictError, SourceMediumMismatchError, SourcePersistenceFailedError } from "./errors";
import { LibraryConflictError } from "@/modules/library/internal/errors";
import type { ContributionRole, ExternalGameRef, GameContribution, GameRecord, LibraryGameQuery, Medium, SourceCategory, SourceSnapshot } from "./types";
import { filterAndSortLibraryGames, sourceCategoryFacets } from "./library-query";
import {
  CommandIdempotencyConflictError,
  CommandTargetNotFoundError,
  CommandVersionConflictError,
  commandPayloadSha256,
  normalizeGameEditPayload,
  type GameEditCommand,
  type VersionedCommandResult,
} from "@/modules/commands";

export type GameEditInput = Readonly<{
  displayName?: string | null;
  actualPlatforms?: readonly string[];
  tags?: readonly string[];
  playerCountNote?: string | null;
}>;

export type ContributorMatch = Readonly<{
  contributorId: string;
  name: string;
  entityKind: "person" | "company";
  provider: "bgg" | "igdb" | null;
  sourceContributorId: string | null;
  rolesOnGame: readonly ContributionRole[];
}>;

export type ExistingManualContributionInput = Readonly<{
  kind: "existing";
  gameId: string;
  contributorId: string;
  role: ContributionRole;
}>;

export type NewManualContributionInput = Readonly<{
  kind: "new";
  gameId: string;
  name: string;
  entityKind: "person" | "company";
  role: ContributionRole;
  allowDuplicate: boolean;
}>;

export type ManualContributionInput = ExistingManualContributionInput | NewManualContributionInput;

/** @deprecated 僅供尚未切換確認流程的 private action 過渡使用。 */
export type LegacyManualContributionInput = Readonly<{
  gameId: string;
  name: string;
  entityKind: "person" | "company";
  role: ContributionRole;
}>;

export type ManualContributionResult =
  | Readonly<{ status: "created"; game: GameRecord; possibleDuplicate: false }>
  | Readonly<{ status: "confirmation_required"; matches: readonly ContributorMatch[]; possibleDuplicate: true }>;
export type SharedLibraryItem = Readonly<{ name: string; usageCount: number; isSystem: boolean }>;
export type ContributorFacet = Readonly<{ contributorId: string; name: string; entityKind: "person" | "company"; provider: "bgg" | "igdb" | null; role: ContributionRole }>;

export type GameStore = {
  list(query?: string): Promise<readonly GameRecord[]>;
  listLibraryGames(query?: LibraryGameQuery): Promise<readonly GameRecord[]>;
  listSourceCategoryFacets(medium: Medium): Promise<readonly SourceCategory[]>;
  listContributorFacets(): Promise<readonly ContributorFacet[]>;
  get(id: string): Promise<GameRecord | null>;
  createManual(displayName: string, medium: Medium): Promise<GameRecord>;
  createFromSource(ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<{ game: GameRecord; created: boolean }>;
  linkFromSource(gameId: string, ref: ExternalGameRef, snapshot: SourceSnapshot): Promise<GameRecord>;
  refreshSource(gameId: string, snapshot: SourceSnapshot, operationId: string): Promise<GameRecord>;
  edit(gameId: string, input: GameEditInput): Promise<GameRecord>;
  editWithCommand(command: GameEditCommand): Promise<VersionedCommandResult>;
  cleanupExpiredCommandReceipts(limit: number): Promise<number>;
  findContributorMatches(gameId: string, name: string): Promise<readonly ContributorMatch[]>;
  addManualContribution(input: ManualContributionInput | LegacyManualContributionInput): Promise<ManualContributionResult>;
  removeManualContribution(gameId: string, contributionId: string): Promise<GameRecord>;
  deletePlatform(name: string): Promise<void>;
  deleteTag(name: string): Promise<void>;
  listPlatforms(): Promise<readonly SharedLibraryItem[]>;
  listTags(): Promise<readonly SharedLibraryItem[]>;
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

type ContributorEntity = Readonly<{
  id: string;
  name: string;
  entityKind: "person" | "company";
  provider: "bgg" | "igdb" | null;
  sourceContributorId: string | null;
}>;

function assertVideoGamePlatforms(medium: Medium, platforms: readonly string[]) {
  if (medium === "board_game" && platforms.length > 0) throw new Error("桌遊不可設定實際平台。");
}

const SYSTEM_PLATFORMS = new Set(["steam", "ps5", "xbox series", "nintendo switch"]);

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, GameRecord>();
  private readonly identities = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly contributors = new Map<string, ContributorEntity>();
  private readonly sourceContributors = new Map<string, string>();
  private readonly customPlatforms = new Map<string, string>();
  private readonly customTags = new Map<string, string>();
  private readonly commandReceipts = new Map<string, Readonly<{
    ownerId: string;
    gameId: string;
    expectedVersion: number;
    payloadSha256: string;
    result: Omit<VersionedCommandResult, "replayed">;
    expiresAt: number;
  }>>();

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.locks.set(key, lock);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(key) === lock) this.locks.delete(key);
    }
  }

  private sourceContributionsFor(snapshot: SourceSnapshot): readonly GameContribution[] {
    return snapshot.contributors.map((contributor) => {
      const sourceKey = `${snapshot.ref.provider}:${contributor.sourceContributorId}`;
      const existingId = this.sourceContributors.get(sourceKey);
      const entity: ContributorEntity = existingId
        ? { id: existingId, name: contributor.name, entityKind: contributor.entityKind, provider: snapshot.ref.provider, sourceContributorId: contributor.sourceContributorId }
        : { id: randomUUID(), name: contributor.name, entityKind: contributor.entityKind, provider: snapshot.ref.provider, sourceContributorId: contributor.sourceContributorId };
      this.contributors.set(entity.id, entity);
      this.sourceContributors.set(sourceKey, entity.id);
      return { id: `source:${snapshot.ref.provider}:${contributor.sourceContributorId}:${contributor.role}`, contributorId: entity.id, name: entity.name, entityKind: entity.entityKind, role: contributor.role, origin: "source" as const, provider: snapshot.ref.provider, sourceContributorId: contributor.sourceContributorId };
    });
  }

  private matchesFor(game: GameRecord, name: string): readonly ContributorMatch[] {
    const key = normalize(name);
    return [...this.contributors.values()]
      .filter((contributor) => normalize(contributor.name) === key)
      .map((contributor) => ({
        contributorId: contributor.id,
        name: contributor.name,
        entityKind: contributor.entityKind,
        provider: contributor.provider,
        sourceContributorId: contributor.sourceContributorId,
        rolesOnGame: game.contributors.filter((item) => item.contributorId === contributor.id).map((item) => item.role),
      }));
  }

  private assertContributionIsNew(game: GameRecord, contributorId: string, role: ContributionRole): void {
    if (game.contributors.some((item) => item.contributorId === contributorId && item.role === role)) {
      throw new LibraryConflictError("library_contribution_exists", "此貢獻者已在此遊戲擁有相同分類。");
    }
  }

  async list(query = ""): Promise<readonly GameRecord[]> {
    return this.listLibraryGames({ search: query });
  }

  async listLibraryGames(query: LibraryGameQuery = {}): Promise<readonly GameRecord[]> {
    return filterAndSortLibraryGames([...this.games.values()].filter((game) => game.trashedAt === null), query);
  }

  async listSourceCategoryFacets(medium: Medium): Promise<readonly SourceCategory[]> {
    return sourceCategoryFacets([...this.games.values()].filter((game) => game.trashedAt === null), medium);
  }

  async listContributorFacets(): Promise<readonly ContributorFacet[]> {
    const facets = new Map<string, ContributorFacet>();
    for (const game of this.games.values()) {
      if (game.trashedAt !== null) continue;
      for (const contribution of game.contributors) {
        if (contribution.contributorId === null) continue;
        const contributor = this.contributors.get(contribution.contributorId);
        if (!contributor) throw new SourcePersistenceFailedError();
        facets.set(`${contribution.role}:${contribution.contributorId}`, {
          contributorId: contribution.contributorId,
          name: contributor.name,
          entityKind: contributor.entityKind,
          provider: contributor.provider,
          role: contribution.role,
        });
      }
    }
    return [...facets.values()].sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name, "zh-Hant") || left.contributorId.localeCompare(right.contributorId));
  }

  async get(id: string) { return this.games.get(id) ?? null; }

  async createManual(displayName: string, medium: Medium): Promise<GameRecord> {
    const title = displayName.trim();
    if (!title) throw new Error("手動遊戲名稱不可為空。");
    const game: GameRecord = { id: randomUUID(), version: 1, medium, displayName: title, customDisplayName: title, sourceNames: [], aliases: [], actualPlatforms: [], tags: [], contributors: [], playerCountNote: null, coverIngestState: null, trashedAt: null, externalIdentityId: null, snapshot: null, createdAt: new Date().toISOString() };
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
      const game: GameRecord = { id: randomUUID(), version: 1, medium: ref.medium, displayName: snapshot.title, customDisplayName: null, sourceNames: sourceNames(snapshot), aliases: snapshot.aliases, actualPlatforms: [], tags: [], contributors: this.sourceContributionsFor(snapshot), playerCountNote: null, coverIngestState: null, trashedAt: null, externalIdentityId: randomUUID(), snapshot, createdAt: new Date().toISOString() };
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
    if (game.trashedAt) throw new SourceGameUnavailableError();
    if (game.externalIdentityId) throw new Error("遊戲已連結來源。");
    if (game.medium !== ref.medium) throw new SourceMediumMismatchError();
    const existingId = this.identities.get(`${ref.provider}:${ref.sourceId}`);
    if (existingId) {
      const existing = this.games.get(existingId);
      if (existing) throw new SourceIdentityConflictError(existing.id, existing.trashedAt !== null);
    }
    const linked = { ...game, displayName: game.customDisplayName ?? snapshot.title, sourceNames: sourceNames(snapshot), aliases: snapshot.aliases, externalIdentityId: randomUUID(), snapshot, contributors: [...this.sourceContributionsFor(snapshot), ...game.contributors.filter((contributor) => contributor.origin === "manual")] };
    this.games.set(gameId, linked);
    this.identities.set(`${ref.provider}:${ref.sourceId}`, gameId);
    return linked;
  }

  async refreshSource(gameId: string, snapshot: SourceSnapshot, operationId: string): Promise<GameRecord> {
    void operationId;
    const game = this.games.get(gameId);
    if (!game || !game.externalIdentityId) throw new Error("遊戲尚未連結來源。");
    if (game.trashedAt) throw new SourceGameUnavailableError();
    const refreshed = {
      ...game,
      displayName: game.customDisplayName ?? snapshot.title,
      sourceNames: sourceNames(snapshot),
      aliases: snapshot.aliases,
      snapshot,
      contributors: [...this.sourceContributionsFor(snapshot), ...game.contributors.filter((contributor) => contributor.origin === "manual")],
    };
    this.games.set(gameId, refreshed);
    return refreshed;
  }

  async edit(gameId: string, input: GameEditInput): Promise<GameRecord> {
    const game = this.games.get(gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    const actualPlatforms = input.actualPlatforms === undefined ? game.actualPlatforms : uniqueNames(input.actualPlatforms);
    assertVideoGamePlatforms(game.medium, actualPlatforms);
    const tags = input.tags === undefined ? game.tags : uniqueNames(input.tags);
    for (const platform of actualPlatforms) {
      const key = normalize(platform);
      if (!SYSTEM_PLATFORMS.has(key) && !this.customPlatforms.has(key)) this.customPlatforms.set(key, platform);
    }
    for (const tag of tags) {
      const key = normalize(tag);
      if (!this.customTags.has(key)) this.customTags.set(key, tag);
    }
    const customDisplayName = input.displayName === undefined ? game.customDisplayName : input.displayName === null ? null : input.displayName.trim() || null;
    const updated = { ...game, customDisplayName, displayName: customDisplayName ?? game.snapshot?.title ?? game.sourceNames[0] ?? game.displayName, actualPlatforms, tags, playerCountNote: input.playerCountNote === undefined ? game.playerCountNote : input.playerCountNote?.trim() || null };
    this.games.set(gameId, updated);
    return updated;
  }

  async editWithCommand(command: GameEditCommand): Promise<VersionedCommandResult> {
    const commandId = command.commandId.toLowerCase();
    const gameId = command.gameId.toLowerCase();
    return this.withLock(`command:${commandId}`, async () => this.withLock(`game:${gameId}`, async () => {
      const payload = normalizeGameEditPayload(command.payload);
      const payloadSha256 = commandPayloadSha256(payload);
      let existing = this.commandReceipts.get(commandId);
      if (existing && existing.expiresAt <= Date.now()) {
        this.commandReceipts.delete(commandId);
        existing = undefined;
      }
      if (existing) {
        if (existing.ownerId !== command.ownerId || existing.gameId !== gameId || existing.expectedVersion !== command.expectedVersion || existing.payloadSha256 !== payloadSha256) {
          throw new CommandIdempotencyConflictError();
        }
        return { ...existing.result, replayed: true };
      }
      const game = this.games.get(gameId);
      if (!game) throw new CommandTargetNotFoundError();
      const state = game.trashedAt === null ? "active" as const : "trashed" as const;
      if (game.version !== command.expectedVersion) throw new CommandVersionConflictError(game.version, state);
      const updated = await this.edit(gameId, payload);
      const result = { resourceId: updated.id, version: updated.version + 1, state: updated.trashedAt === null ? "active" as const : "trashed" as const };
      this.games.set(gameId, { ...updated, version: result.version });
      this.commandReceipts.set(commandId, { ownerId: command.ownerId, gameId, expectedVersion: command.expectedVersion, payloadSha256, result, expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1_000 });
      return { ...result, replayed: false };
    }));
  }

  async cleanupExpiredCommandReceipts(limit: number): Promise<number> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 500));
    const expired = [...this.commandReceipts.entries()]
      .filter(([, receipt]) => receipt.expiresAt <= Date.now())
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt || left[0].localeCompare(right[0]))
      .slice(0, boundedLimit);
    for (const [commandId] of expired) this.commandReceipts.delete(commandId);
    return expired.length;
  }

  async findContributorMatches(gameId: string, name: string): Promise<readonly ContributorMatch[]> {
    const game = this.games.get(gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    return this.matchesFor(game, name);
  }

  async addManualContribution(input: ManualContributionInput | LegacyManualContributionInput): Promise<ManualContributionResult> {
    const game = this.games.get(input.gameId);
    if (!game) throw new Error("找不到遊戲條目。");
    if (!("kind" in input) || input.kind === "new") {
      const name = input.name.trim();
      if (!name) throw new Error("貢獻者名稱不可為空。");
      const allowDuplicate = "kind" in input && input.kind === "new" ? input.allowDuplicate : false;
      const matches = this.matchesFor(game, name);
      if (matches.length > 0 && !allowDuplicate) return { status: "confirmation_required", matches, possibleDuplicate: true };
      const contributorId = randomUUID();
      const contributor: ContributorEntity = { id: contributorId, name, entityKind: input.entityKind, provider: null, sourceContributorId: null };
      this.contributors.set(contributorId, contributor);
      const contribution: GameContribution = { id: randomUUID(), contributorId, name, entityKind: contributor.entityKind, role: input.role, origin: "manual", provider: null, sourceContributorId: null };
      const updated = { ...game, contributors: [...game.contributors, contribution] };
      this.games.set(game.id, updated);
      return { status: "created", game: updated, possibleDuplicate: false };
    }
    const contributor = this.contributors.get(input.contributorId);
    if (!contributor) throw new Error("找不到貢獻者。");
    this.assertContributionIsNew(game, contributor.id, input.role);
    const contribution: GameContribution = { id: randomUUID(), contributorId: contributor.id, name: contributor.name, entityKind: contributor.entityKind, role: input.role, origin: "manual", provider: null, sourceContributorId: null };
    const updated = { ...game, contributors: [...game.contributors, contribution] };
    this.games.set(game.id, updated);
    return { status: "created", game: updated, possibleDuplicate: false };
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
    if (SYSTEM_PLATFORMS.has(key)) throw new LibraryConflictError("library_system_platform", "系統預設平台不可刪除。");
    if ([...this.games.values()].some((game) => game.actualPlatforms.some((platform) => normalize(platform) === key))) throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此平台，請先移除關係。");
    this.customPlatforms.delete(key);
  }

  async deleteTag(name: string): Promise<void> {
    const key = normalize(name);
    if ([...this.games.values()].some((game) => game.tags.some((tag) => normalize(tag) === key))) throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此標籤，請先移除關係。");
    this.customTags.delete(key);
  }

  async listPlatforms(): Promise<readonly SharedLibraryItem[]> {
    const usage = new Map<string, number>();
    const displayNames = new Map<string, string>([["steam", "Steam"], ["ps5", "PS5"], ["xbox series", "Xbox Series"], ["nintendo switch", "Nintendo Switch"]]);
    for (const [key, name] of this.customPlatforms) displayNames.set(key, name);
    for (const game of this.games.values()) {
      for (const platform of game.actualPlatforms) {
        const key = normalize(platform);
        usage.set(key, (usage.get(key) ?? 0) + 1);
        if (!displayNames.has(key)) displayNames.set(key, platform);
      }
    }
    return [...new Set([...SYSTEM_PLATFORMS, ...this.customPlatforms.keys(), ...usage.keys()])].map((key) => ({ name: displayNames.get(key) ?? key, usageCount: usage.get(key) ?? 0, isSystem: SYSTEM_PLATFORMS.has(key) })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }

  async listTags(): Promise<readonly SharedLibraryItem[]> {
    const names = new Map<string, SharedLibraryItem>();
    for (const [key, name] of this.customTags) names.set(key, { name, usageCount: 0, isSystem: false });
    for (const game of this.games.values()) {
      for (const tag of game.tags) { const key = normalize(tag); names.set(key, { name: names.get(key)?.name ?? tag, usageCount: (names.get(key)?.usageCount ?? 0) + 1, isSystem: false }); }
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }

  async trash(id: string) {
    const game = this.games.get(id);
    if (game) this.games.set(id, { ...game, trashedAt: new Date().toISOString() });
  }
}

export class UnavailableGameStore implements GameStore {
  private fail(): never { throw new SourcePersistenceFailedError(); }
  async list(): Promise<readonly GameRecord[]> { return this.fail(); }
  async listLibraryGames(): Promise<readonly GameRecord[]> { return this.fail(); }
  async listSourceCategoryFacets(): Promise<readonly SourceCategory[]> { return this.fail(); }
  async listContributorFacets(): Promise<readonly ContributorFacet[]> { return this.fail(); }
  async get(): Promise<GameRecord | null> { return this.fail(); }
  async createManual(): Promise<GameRecord> { return this.fail(); }
  async createFromSource(): Promise<{ game: GameRecord; created: boolean }> { return this.fail(); }
  async linkFromSource(): Promise<GameRecord> { return this.fail(); }
  async refreshSource(): Promise<GameRecord> { return this.fail(); }
  async edit(): Promise<GameRecord> { return this.fail(); }
  async editWithCommand(): Promise<VersionedCommandResult> { return this.fail(); }
  async cleanupExpiredCommandReceipts(): Promise<number> { return this.fail(); }
  async findContributorMatches(): Promise<readonly ContributorMatch[]> { return this.fail(); }
  async addManualContribution(): Promise<ManualContributionResult> { return this.fail(); }
  async removeManualContribution(): Promise<GameRecord> { return this.fail(); }
  async deletePlatform(): Promise<void> { this.fail(); }
  async deleteTag(): Promise<void> { this.fail(); }
  async listPlatforms(): Promise<readonly SharedLibraryItem[]> { return this.fail(); }
  async listTags(): Promise<readonly SharedLibraryItem[]> { return this.fail(); }
  async trash(): Promise<void> { this.fail(); }
}

import { NamedError } from "@/shared/errors/named-error";
import type { ExternalGameRef } from "@/modules/games/internal/types";

export type RelationTarget = Readonly<
  | { kind: "game"; gameId: string }
  | { kind: "external"; ref: ExternalGameRef; name: string; releaseYear: number | null; thumbnailState?: "missing" | "pending" | "ready" | "failed"; thumbnailUrl?: string | null }
>;
export type GameRelation = Readonly<{
  id: string;
  version: number;
  left: RelationTarget;
  right: RelationTarget;
  leftGameId: string | null;
  rightGameId: string | null;
  leftTrashed: boolean;
  rightTrashed: boolean;
  description: string | null;
  removed: boolean;
}>;
export type RelationResult = Readonly<{ resourceId: string; version: number; state: "active" | "removed"; replayed: boolean }>;
export type AddRelationCommand = Readonly<{ ownerId: string; commandId: string; left: RelationTarget; right: RelationTarget }>;
export type RelationCommand = Readonly<{ ownerId: string; commandId: string; relationId: string; expectedVersion: number }>;
export interface RelationStore {
  forGame(gameId: string): Promise<readonly GameRelation[]>;
  add(command: AddRelationCommand): Promise<RelationResult>;
  remove(command: RelationCommand): Promise<RelationResult>;
  restore(command: RelationCommand): Promise<RelationResult>;
  describe(command: RelationCommand & { description: string | null }): Promise<RelationResult>;
}

export class RelationInvalidError extends NamedError {
  constructor() { super("relation_invalid", "請選擇兩款不同且可使用的遊戲。"); this.name = "RelationInvalidError"; }
}
export class RelationConflictError extends NamedError {
  constructor(readonly restorable: boolean, readonly relationId?: string, readonly currentVersion?: number) { super("relation_conflict", restorable ? "這組關聯已解除，請先還原。" : "這兩款遊戲已建立關聯。"); this.name = "RelationConflictError"; }
}
export class RelationStateConflictError extends NamedError {
  constructor() { super("relation_state_conflict", "關聯目前狀態無法執行此操作。"); this.name = "RelationStateConflictError"; }
}

export function relationTargetKey(target: RelationTarget) {
  return target.kind === "game" ? `game:${target.gameId}` : `${target.ref.provider}:${target.ref.sourceId}`;
}
export function relationCommandBinding(target: RelationTarget) {
  return target.kind === "game" ? { kind: "game" as const, gameId: target.gameId } : { kind: "external" as const, ref: target.ref };
}
export function createRelationsService(store: RelationStore) {
  return {
    forGame: (gameId: string) => store.forGame(gameId),
    add: (command: AddRelationCommand) => store.add(command),
    remove: (command: RelationCommand) => store.remove(command),
    restore: (command: RelationCommand) => store.restore(command),
    describe: (command: RelationCommand & { description: string | null }) => store.describe(command),
  } as const;
}
export type RelationsService = ReturnType<typeof createRelationsService>;

export { InMemoryRelationStore } from "./in-memory-store";

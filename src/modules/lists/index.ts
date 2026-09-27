import { NamedError } from "@/shared/errors/named-error";
import type { ExternalGameRef } from "@/modules/games/internal/types";

export type ListTarget = Readonly<{ kind: "game"; gameId: string } | { kind: "external"; ref: ExternalGameRef; name: string; releaseYear: number | null }>;
export type ListRecord = Readonly<{ id: string; name: string; version: number; archived: boolean; memberCount: number }>;
export type ListMember = Readonly<{ id: string; listId: string; target: ListTarget; resolvedGameId: string | null; trashed: boolean; description: string | null; version: number; removed: boolean; thumbnailState: "missing" | "pending" | "ready" | "failed"; thumbnailUrl: string | null }>;
export type ListResult = Readonly<{ resourceId: string; version: number; state: "active" | "archived" | "removed"; replayed: boolean }>;
export type ListCommand = Readonly<{ ownerId: string; commandId: string; listId: string; expectedVersion: number }>;
export type CreateListCommand = Readonly<{ ownerId: string; commandId: string; name: string; firstMember: ListTarget }>;
export type AddListMemberCommand = ListCommand & Readonly<{ member: ListTarget }>;
export type MemberCommand = Readonly<{ ownerId: string; commandId: string; memberId: string; expectedVersion: number }>;

export interface ListStore {
  list(): Promise<readonly ListRecord[]>;
  archivedForGame(gameId: string): Promise<readonly ListRecord[]>;
  get(listId: string): Promise<{ list: ListRecord; members: readonly ListMember[] } | null>;
  findName(name: string): Promise<ListRecord | null>;
  create(command: CreateListCommand): Promise<ListResult>;
  add(command: AddListMemberCommand): Promise<ListResult>;
  archive(command: ListCommand): Promise<ListResult>;
  restore(command: ListCommand): Promise<ListResult>;
  removeMember(command: MemberCommand): Promise<ListResult>;
  restoreMember(command: MemberCommand): Promise<ListResult>;
  describeMember(command: MemberCommand & { description: string | null }): Promise<ListResult>;
}

export class ListNameInvalidError extends NamedError {
  constructor() { super("list_name_invalid", "清單名稱須為 1 至 120 個字元。"); this.name = "ListNameInvalidError"; }
}
export class ListNameInUseError extends NamedError {
  constructor(readonly existing: ListRecord) { super(existing.archived ? "archived_list_found" : "list_name_in_use", existing.archived ? "同名清單已封存，請先還原。" : "已有同名清單。"); this.name = "ListNameInUseError"; }
}
export class ListMemberConflictError extends NamedError {
  constructor(readonly restorable: boolean) { super("list_member_conflict", restorable ? "此成員已移除，請先還原。" : "此遊戲已在清單中。"); this.name = "ListMemberConflictError"; }
}
export class ListStateConflictError extends NamedError {
  constructor() { super("list_state_conflict", "清單目前狀態無法執行此操作。"); this.name = "ListStateConflictError"; }
}
export class ListReferenceInvalidError extends NamedError {
  constructor() { super("list_reference_invalid", "請從具有穩定來源身分的搜尋結果加入庫外遊戲。"); this.name = "ListReferenceInvalidError"; }
}

export function normalizeListName(name: string): string {
  const result = name.trim();
  if (!result || result.length > 120) throw new ListNameInvalidError();
  return result;
}

export function listTargetCommandBinding(target: ListTarget): Readonly<{ kind: "game"; gameId: string } | { kind: "external"; ref: ExternalGameRef }> {
  return target.kind === "game" ? target : { kind: "external", ref: target.ref };
}

export function createListIntentKey(name: string, target: ListTarget): string {
  return JSON.stringify({ name: name.trim(), target: listTargetCommandBinding(target) });
}

export function shouldRetainListCommand(errorCode: string): boolean {
  return errorCode === "operation_failed";
}

export function createListsService(store: ListStore) {
  return {
    list: () => store.list(),
    archivedForGame: (gameId: string) => store.archivedForGame(gameId),
    get: (id: string) => store.get(id),
    findName: (name: string) => store.findName(normalizeListName(name)),
    create: (command: CreateListCommand) => store.create({ ...command, name: normalizeListName(command.name) }),
    add: (command: AddListMemberCommand) => store.add(command),
    archive: (command: ListCommand) => store.archive(command),
    restore: (command: ListCommand) => store.restore(command),
    removeMember: (command: MemberCommand) => store.removeMember(command),
    restoreMember: (command: MemberCommand) => store.restoreMember(command),
    describeMember: (command: MemberCommand & { description: string | null }) => store.describeMember(command),
  } as const;
}
export type ListsService = ReturnType<typeof createListsService>;

export { InMemoryListStore } from "./in-memory-store";

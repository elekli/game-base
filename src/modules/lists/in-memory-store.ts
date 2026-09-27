import { randomUUID } from "node:crypto";
import { CommandIdempotencyConflictError, CommandTargetNotFoundError, CommandVersionConflictError, commandPayloadSha256 } from "@/modules/commands";
import { ListMemberConflictError, ListNameInUseError, ListStateConflictError, listTargetCommandBinding, type AddListMemberCommand, type CreateListCommand, type ListCommand, type ListMember, type ListRecord, type ListResult, type ListStore, type ListTarget, type MemberCommand } from ".";

type StoredList = Omit<ListRecord, "memberCount">;
type Receipt = Readonly<{ binding: string; result: ListResult }>;

function targetKey(target: ListTarget): string {
  return target.kind === "game" ? `game:${target.gameId}` : `${target.ref.provider}:${target.ref.sourceId}`;
}

export class InMemoryListStore implements ListStore {
  private readonly lists = new Map<string, StoredList>();
  private readonly members = new Map<string, ListMember>();
  private readonly receipts = new Map<string, Receipt>();

  async list() { return [...this.lists.values()].filter((list) => !list.archived).map((list) => this.withCount(list)).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")); }
  async archivedForGame(gameId: string) {
    const listIds = new Set([...this.members.values()].filter((member) => !member.removed && member.resolvedGameId === gameId).map((member) => member.listId));
    return [...this.lists.values()].filter((list) => list.archived && listIds.has(list.id)).map((list) => this.withCount(list)).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }
  async get(listId: string) {
    const list = this.lists.get(listId);
    if (!list) return null;
    return { list: this.withCount(list), members: [...this.members.values()].filter((member) => member.listId === listId) };
  }
  async findName(name: string) {
    const key = name.toLocaleLowerCase();
    const list = [...this.lists.values()].find((candidate) => candidate.name.toLocaleLowerCase() === key);
    return list ? this.withCount(list) : null;
  }
  async create(command: CreateListCommand) {
    return this.run(command.commandId, [command.ownerId, "list.create", commandPayloadSha256({ name: command.name, firstMember: listTargetCommandBinding(command.firstMember) })], () => {
      const clash = [...this.lists.values()].find((list) => list.name.toLocaleLowerCase() === command.name.toLocaleLowerCase());
      if (clash) throw new ListNameInUseError(this.withCount(clash));
      const list: StoredList = { id: randomUUID(), name: command.name, version: 1, archived: false };
      const member = this.newMember(list.id, command.firstMember);
      this.lists.set(list.id, list); this.members.set(member.id, member);
      return { resourceId: list.id, version: 1, state: "active", replayed: false };
    });
  }
  async add(command: AddListMemberCommand) {
    return this.run(command.commandId, [command.ownerId, "list.add", command.listId, command.expectedVersion, commandPayloadSha256({ member: listTargetCommandBinding(command.member) })], () => {
      const list = this.activeList(command.listId, command.expectedVersion);
      this.assertUnique(list.id, command.member);
      const member = this.newMember(list.id, command.member);
      const updated = { ...list, version: list.version + 1 };
      this.lists.set(list.id, updated); this.members.set(member.id, member);
      return { resourceId: list.id, version: updated.version, state: "active", replayed: false };
    });
  }
  async archive(command: ListCommand) { return this.changeList("list.archive", command, true); }
  async restore(command: ListCommand) { return this.changeList("list.restore", command, false); }
  async removeMember(command: MemberCommand) { return this.changeMember("list.member.remove", command); }
  async restoreMember(command: MemberCommand) { return this.changeMember("list.member.restore", command); }
  async describeMember(command: MemberCommand & { description: string | null }) { return this.changeMember("list.member.describe", command, command.description); }

  private changeList(kind: string, command: ListCommand, archived: boolean) {
    return this.run(command.commandId, [command.ownerId, kind, command.listId, command.expectedVersion, commandPayloadSha256({})], () => {
      const list = this.lists.get(command.listId);
      if (!list) throw new CommandTargetNotFoundError();
      if (list.version !== command.expectedVersion) throw new CommandVersionConflictError(list.version, list.archived ? "removed" : "active");
      if (list.archived === archived) throw new ListStateConflictError();
      const updated = { ...list, archived, version: list.version + 1 };
      this.lists.set(list.id, updated);
      return { resourceId: list.id, version: updated.version, state: archived ? "archived" : "active", replayed: false };
    });
  }
  private changeMember(kind: string, command: MemberCommand, description?: string | null) {
    return this.run(command.commandId, [command.ownerId, kind, command.memberId, command.expectedVersion, commandPayloadSha256(kind === "list.member.describe" ? { description } : {})], () => {
      const member = this.members.get(command.memberId);
      if (!member) throw new CommandTargetNotFoundError();
      const list = this.activeList(member.listId, null);
      if (member.version !== command.expectedVersion) throw new CommandVersionConflictError(member.version, member.removed ? "removed" : "active");
      if ((kind === "list.member.remove" && member.removed) || (kind === "list.member.restore" && !member.removed) || (kind === "list.member.describe" && member.removed)) throw new ListStateConflictError();
      const updated = { ...member, removed: kind === "list.member.remove" ? true : kind === "list.member.restore" ? false : member.removed, description: kind === "list.member.describe" ? description ?? null : member.description, version: member.version + 1 };
      this.members.set(member.id, updated);
      if (kind !== "list.member.describe") this.lists.set(list.id, { ...list, version: list.version + 1 });
      return { resourceId: member.id, version: updated.version, state: updated.removed ? "removed" : "active", replayed: false };
    });
  }
  private activeList(id: string, expectedVersion: number | null) {
    const list = this.lists.get(id);
    if (!list) throw new CommandTargetNotFoundError();
    if (expectedVersion !== null && list.version !== expectedVersion) throw new CommandVersionConflictError(list.version, list.archived ? "removed" : "active");
    if (list.archived) throw new ListStateConflictError();
    return list;
  }
  private assertUnique(listId: string, target: ListTarget) {
    const existing = [...this.members.values()].find((member) => member.listId === listId && targetKey(member.target) === targetKey(target));
    if (existing) throw new ListMemberConflictError(existing.removed);
  }
  private newMember(listId: string, target: ListTarget): ListMember {
    this.assertUnique(listId, target);
    return { id: randomUUID(), listId, target, resolvedGameId: target.kind === "game" ? target.gameId : null, trashed: false, description: null, version: 1, removed: false, thumbnailState: "missing", thumbnailUrl: null };
  }
  private withCount(list: StoredList): ListRecord { return { ...list, memberCount: [...this.members.values()].filter((member) => member.listId === list.id && !member.removed).length }; }
  private async run(commandId: string, parts: readonly unknown[], mutation: () => ListResult): Promise<ListResult> {
    const binding = JSON.stringify(parts);
    const receipt = this.receipts.get(commandId);
    if (receipt) {
      if (receipt.binding !== binding) throw new CommandIdempotencyConflictError();
      return { ...receipt.result, replayed: true };
    }
    const result = mutation();
    this.receipts.set(commandId, { binding, result });
    return result;
  }
}

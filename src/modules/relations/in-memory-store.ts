import { randomUUID } from "node:crypto";
import { CommandIdempotencyConflictError, CommandTargetNotFoundError, CommandVersionConflictError, commandPayloadSha256 } from "@/modules/commands";
import { RelationConflictError, RelationInvalidError, RelationStateConflictError, relationCommandBinding, relationTargetKey, type AddRelationCommand, type GameRelation, type RelationCommand, type RelationResult, type RelationStore } from ".";

type Receipt = Readonly<{ binding: string; result: RelationResult }>;

export class InMemoryRelationStore implements RelationStore {
  private readonly relations = new Map<string, GameRelation>();
  private readonly receipts = new Map<string, Receipt>();

  async forGame(gameId: string) {
    return [...this.relations.values()].filter((relation) => !relation.removed && (relation.leftGameId === gameId || relation.rightGameId === gameId)).sort((a, b) => {
      const left = a.leftGameId === gameId ? a.right : a.left;
      const right = b.leftGameId === gameId ? b.right : b.left;
      return relationTargetKey(left).localeCompare(relationTargetKey(right));
    });
  }

  async add(command: AddRelationCommand) {
    const pair = [relationTargetKey(command.left), relationTargetKey(command.right)].sort();
    if (pair[0] === pair[1]) throw new RelationInvalidError();
    const targetId = pair.join("|");
    return this.run(command.commandId, [command.ownerId, "relation.add", targetId, null, commandPayloadSha256({ left: relationCommandBinding(command.left), right: relationCommandBinding(command.right) })], () => {
      const existing = [...this.relations.values()].find((relation) => [relationTargetKey(relation.left), relationTargetKey(relation.right)].sort().join("|") === targetId);
      if (existing) throw new RelationConflictError(existing.removed, existing.id, existing.version);
      const id = randomUUID();
      this.relations.set(id, { id, version: 1, left: command.left, right: command.right, leftGameId: command.left.kind === "game" ? command.left.gameId : null, rightGameId: command.right.kind === "game" ? command.right.gameId : null, leftTrashed: false, rightTrashed: false, description: null, removed: false });
      return { resourceId: id, version: 1, state: "active", replayed: false };
    });
  }

  async remove(command: RelationCommand) { return this.change(command, "relation.remove", (relation) => { if (relation.removed) throw new RelationStateConflictError(); return { ...relation, removed: true, version: relation.version + 1 }; }, "removed"); }
  async restore(command: RelationCommand) { return this.change(command, "relation.restore", (relation) => { if (!relation.removed) throw new RelationStateConflictError(); return { ...relation, removed: false, version: relation.version + 1 }; }, "active"); }
  async describe(command: RelationCommand & { description: string | null }) {
    if (command.description !== null && command.description.length > 1000) throw new RelationInvalidError();
    return this.run(command.commandId, [command.ownerId, "relation.describe", command.relationId, command.expectedVersion, commandPayloadSha256({ description: command.description })], () => {
      const relation = this.relations.get(command.relationId);
      if (!relation) throw new CommandTargetNotFoundError();
      if (relation.version !== command.expectedVersion) throw new CommandVersionConflictError(relation.version, relation.removed ? "removed" : "active");
      if (relation.removed) throw new RelationStateConflictError();
      const updated = { ...relation, description: command.description, version: relation.version + 1 };
      this.relations.set(relation.id, updated);
      return { resourceId: relation.id, version: updated.version, state: "active", replayed: false };
    });
  }

  private change(command: RelationCommand, kind: "relation.remove" | "relation.restore", update: (relation: GameRelation) => GameRelation, state: RelationResult["state"]) {
    return this.run(command.commandId, [command.ownerId, kind, command.relationId, command.expectedVersion, commandPayloadSha256({})], () => {
      const relation = this.relations.get(command.relationId);
      if (!relation) throw new CommandTargetNotFoundError();
      if (relation.version !== command.expectedVersion) throw new CommandVersionConflictError(relation.version, relation.removed ? "removed" : "active");
      const updated = update(relation);
      this.relations.set(relation.id, updated);
      return { resourceId: relation.id, version: updated.version, state, replayed: false };
    });
  }

  private run(commandId: string, bindingParts: readonly unknown[], operation: () => RelationResult): RelationResult {
    const binding = JSON.stringify(bindingParts);
    const existing = this.receipts.get(commandId);
    if (existing) {
      if (existing.binding !== binding) throw new CommandIdempotencyConflictError();
      return { ...existing.result, replayed: true };
    }
    const result = operation();
    this.receipts.set(commandId, { binding, result });
    return result;
  }
}

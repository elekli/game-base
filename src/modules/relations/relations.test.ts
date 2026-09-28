import { describe, expect, it } from "vitest";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "@/modules/commands";
import { InMemoryRelationStore, RelationConflictError, RelationInvalidError, createRelationsService } from ".";

const uuid = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix.padStart(2, "0")}`;

describe("symmetric game relations", () => {
  it("stores one undirected pair, replays commands, and removes/restores from either side", async () => {
    const service = createRelationsService(new InMemoryRelationStore());
    const left = uuid("1"); const right = uuid("2"); const commandId = uuid("3");
    const created = await service.add({ ownerId: "owner", commandId, left: { kind: "game", gameId: left }, right: { kind: "game", gameId: right } });
    expect(await service.add({ ownerId: "owner", commandId, left: { kind: "game", gameId: left }, right: { kind: "game", gameId: right } })).toEqual({ ...created, replayed: true });
    await expect(service.add({ ownerId: "owner", commandId: uuid("4"), left: { kind: "game", gameId: right }, right: { kind: "game", gameId: left } })).rejects.toBeInstanceOf(RelationConflictError);
    expect(await service.forGame(left)).toHaveLength(1);
    expect(await service.forGame(right)).toHaveLength(1);
    const removed = await service.remove({ ownerId: "owner", commandId: uuid("5"), relationId: created.resourceId, expectedVersion: 1 });
    expect(removed).toMatchObject({ version: 2, state: "removed" });
    expect(await service.forGame(left)).toHaveLength(0);
    await expect(service.restore({ ownerId: "owner", commandId: uuid("6"), relationId: created.resourceId, expectedVersion: 1 })).rejects.toBeInstanceOf(CommandVersionConflictError);
    const restored = await service.restore({ ownerId: "owner", commandId: uuid("7"), relationId: created.resourceId, expectedVersion: 2 });
    expect(restored).toMatchObject({ version: 3, state: "active" });
    expect(await service.forGame(right)).toHaveLength(1);
  });

  it("rejects self-relations and command ID reuse with another payload", async () => {
    const service = createRelationsService(new InMemoryRelationStore());
    const game = uuid("8"); const commandId = uuid("9");
    await expect(service.add({ ownerId: "owner", commandId, left: { kind: "game", gameId: game }, right: { kind: "game", gameId: game } })).rejects.toBeInstanceOf(RelationInvalidError);
    const command = { ownerId: "owner", commandId, left: { kind: "game" as const, gameId: game }, right: { kind: "game" as const, gameId: uuid("10") } };
    await service.add(command);
    await expect(service.add({ ...command, right: { kind: "game", gameId: uuid("11") } })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
  });
});

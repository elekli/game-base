import { afterEach, describe, expect, it, vi } from "vitest";

import { commandPayloadSha256, normalizeGameEditPayload } from "./index";
import { commandIdentityForPayload } from "./client";
import { InMemoryGameStore } from "@/modules/games";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "./index";

afterEach(() => vi.useRealTimers());

describe("command payload fingerprint", () => {
  it("is stable across object key order without storing the payload", () => {
    expect(commandPayloadSha256({ tags: ["合作"], displayName: "名稱" })).toBe(
      commandPayloadSha256({ displayName: "名稱", tags: ["合作"] }),
    );
    expect(commandPayloadSha256({ displayName: "名稱" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes array order and meaningful null values", () => {
    expect(commandPayloadSha256({ tags: ["a", "b"] })).not.toBe(
      commandPayloadSha256({ tags: ["b", "a"] }),
    );
    expect(commandPayloadSha256({ displayName: null })).not.toBe(
      commandPayloadSha256({}),
    );
  });

  it("normalizes only effective edit values before fingerprinting", () => {
    expect(normalizeGameEditPayload({ displayName: "  名稱  ", tags: [" 合作 ", "合作"], playerCountNote: "  " })).toEqual({
      displayName: "名稱",
      tags: ["合作"],
      playerCountNote: null,
    });
  });
});

describe("client command identity", () => {
  it("reuses the command id only while retrying the same payload", () => {
    let sequence = 0;
    const createCommandId = () => `command-${sequence += 1}`;
    const first = commandIdentityForPayload(null, "payload-a", createCommandId);
    const retry = commandIdentityForPayload(first, "payload-a", createCommandId);
    const changed = commandIdentityForPayload(retry, "payload-b", createCommandId);

    expect(retry).toBe(first);
    expect(changed).toEqual({ payloadFingerprint: "payload-b", commandId: "command-2" });
  });
});

describe("in-memory versioned commands", () => {
  it("applies once, safely replays, and rejects command-id payload reuse", async () => {
    const store = new InMemoryGameStore();
    const game = await store.createManual("原名稱", "board_game");
    const command = { ownerId: "owner", commandId: "11111111-1111-4111-8111-111111111111", expectedVersion: 1, gameId: game.id, payload: { displayName: "新名稱" } } as const;

    await expect(store.editWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: false });
    await expect(store.editWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: true });
    await expect(store.editWithCommand({ ...command, payload: { displayName: "另一名稱" } })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
    await expect(store.get(game.id)).resolves.toMatchObject({ displayName: "新名稱", version: 2 });
  });

  it("lets exactly one concurrent command win the same expected version", async () => {
    const store = new InMemoryGameStore();
    const game = await store.createManual("原名稱", "board_game");
    const commands = ["一", "二"].map((displayName, index) => store.editWithCommand({
      ownerId: "owner",
      commandId: `22222222-2222-4222-8222-22222222222${index}`,
      expectedVersion: 1,
      gameId: game.id,
      payload: { displayName },
    }));

    const results = await Promise.allSettled(commands);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof CommandVersionConflictError)).toHaveLength(1);
    await expect(store.get(game.id)).resolves.toMatchObject({ version: 2 });
  });

  it("cleans only expired receipts in bounded batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryGameStore();
    const game = await store.createManual("原名稱", "board_game");
    const command = { ownerId: "owner", commandId: "33333333-3333-4333-8333-333333333333", expectedVersion: 1, gameId: game.id, payload: { displayName: "新名稱" } } as const;
    await store.editWithCommand(command);

    vi.setSystemTime(new Date("2026-04-02T00:00:00.000Z"));
    await expect(store.cleanupExpiredCommandReceipts(0)).resolves.toBe(0);
    await expect(store.cleanupExpiredCommandReceipts(5000)).resolves.toBe(1);
    await expect(store.get(game.id)).resolves.toMatchObject({ displayName: "新名稱", version: 2 });
    await expect(store.editWithCommand(command)).rejects.toBeInstanceOf(CommandVersionConflictError);
  });
});

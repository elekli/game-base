import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "@/adapters/database";
import { PostgresGameStore } from "@/adapters/database-game-store";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "@/modules/commands";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;
if (!directDatabaseUrl) throw new Error("DIRECT_DATABASE_URL is required for PostgreSQL integration tests.");

const ownerId = "command-receipts-test-owner";
const options = { max: 1, prepare: false, onnotice: () => undefined } as const;
let controlDatabase!: ReturnType<typeof postgres>;
let runtimeDatabase!: ReturnType<typeof postgres>;
let applicationDatabase!: ReturnType<typeof createDatabase>;
let store!: PostgresGameStore;

function runtimeUrl(): string {
  const url = new URL(directDatabaseUrl as string);
  url.searchParams.set("options", "-c role=app_runtime");
  return url.toString();
}

async function cleanTestData(): Promise<void> {
  await runtimeDatabase.unsafe("delete from app_private.command_receipts where owner_id = $1", [ownerId]);
  await runtimeDatabase.unsafe("delete from app_private.games where display_name like '命令收據測試：%'");
}

beforeAll(async () => {
  controlDatabase = postgres(directDatabaseUrl as string, options);
  await controlDatabase.unsafe("grant app_runtime to postgres");
  runtimeDatabase = postgres(runtimeUrl(), options);
  applicationDatabase = createDatabase(runtimeUrl());
  store = new PostgresGameStore(applicationDatabase.db);
  await cleanTestData();
});

afterEach(cleanTestData);

afterAll(async () => {
  await cleanTestData();
  await applicationDatabase.close();
  await runtimeDatabase.end();
  await controlDatabase.unsafe("revoke app_runtime from postgres");
  await controlDatabase.end();
});

describe("Postgres command receipts", () => {
  it("applies once, replays the persisted result, and rejects mismatched reuse", async () => {
    const game = await store.createManual("命令收據測試：重播", "board_game");
    const command = { ownerId, commandId: "11111111-1111-4111-8111-111111111111", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：已更新", tags: [" 合作 ", "合作"] } } as const;

    await expect(store.editWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: false });
    await expect(store.editWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: true });
    await expect(store.editWithCommand({ ...command, payload: { displayName: "命令收據測試：不同內容" } })).rejects.toBeInstanceOf(CommandIdempotencyConflictError);
    await expect(store.get(game.id)).resolves.toMatchObject({ displayName: "命令收據測試：已更新", tags: ["合作"], version: 2 });
    await expect(runtimeDatabase.unsafe("select payload_sha256, result_version, result_state from app_private.command_receipts where command_id = $1", [command.commandId])).resolves.toMatchObject([{ payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), result_version: "2", result_state: "active" }]);
  });

  it("allows exactly one concurrent command for the same expected version", async () => {
    const game = await store.createManual("命令收據測試：並行", "board_game");
    const commands = ["甲", "乙"].map((suffix, index) => store.editWithCommand({
      ownerId,
      commandId: `22222222-2222-4222-8222-22222222222${index}`,
      expectedVersion: 1,
      gameId: game.id,
      payload: { displayName: `命令收據測試：${suffix}` },
    }));

    const results = await Promise.allSettled(commands);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof CommandVersionConflictError)).toHaveLength(1);
    await expect(store.get(game.id)).resolves.toMatchObject({ version: 2 });
    await expect(runtimeDatabase.unsafe("select count(*)::int as count from app_private.command_receipts where owner_id = $1", [ownerId])).resolves.toEqual([{ count: 1 }]);
  });

  it("cleans bounded expired receipts without deleting owner content", async () => {
    const game = await store.createManual("命令收據測試：清理", "board_game");
    const commandId = "33333333-3333-4333-8333-333333333333";
    await store.editWithCommand({ ownerId, commandId, expectedVersion: 1, gameId: game.id, payload: { playerCountNote: "保留內容" } });
    await runtimeDatabase.unsafe("update app_private.command_receipts set created_at = now() - interval '91 days', expires_at = now() - interval '1 day' where command_id = $1", [commandId]);

    await expect(store.cleanupExpiredCommandReceipts(0)).resolves.toBe(0);
    await expect(store.cleanupExpiredCommandReceipts(501)).resolves.toBe(1);
    await expect(store.get(game.id)).resolves.toMatchObject({ playerCountNote: "保留內容", version: 2 });
  });
});

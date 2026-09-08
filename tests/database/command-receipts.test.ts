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
let migrationDatabase!: ReturnType<typeof postgres>;
let applicationDatabase!: ReturnType<typeof createDatabase>;
let store!: PostgresGameStore;

function runtimeUrl(): string {
  const url = new URL(directDatabaseUrl as string);
  url.searchParams.set("options", "-c role=app_runtime");
  return url.toString();
}

function migratorUrl(): string {
  const url = new URL(directDatabaseUrl as string);
  url.searchParams.set("options", "-c role=app_migrator");
  return url.toString();
}

async function dropReceiptFailure(): Promise<void> {
  await migrationDatabase.unsafe("drop trigger if exists command_receipts_test_failure on app_private.command_receipts");
  await migrationDatabase.unsafe("drop function if exists app_private.command_receipts_test_failure()");
}

async function cleanTestData(): Promise<void> {
  await dropReceiptFailure();
  await runtimeDatabase.unsafe("delete from app_private.command_receipts where owner_id = $1", [ownerId]);
  await runtimeDatabase.unsafe("delete from app_private.games where display_name like '命令收據測試：%'");
}

beforeAll(async () => {
  controlDatabase = postgres(directDatabaseUrl as string, options);
  await controlDatabase.unsafe("grant app_runtime to postgres");
  await controlDatabase.unsafe("grant app_migrator to postgres");
  runtimeDatabase = postgres(runtimeUrl(), options);
  migrationDatabase = postgres(migratorUrl(), options);
  applicationDatabase = createDatabase(runtimeUrl());
  store = new PostgresGameStore(applicationDatabase.db);
  await cleanTestData();
});

afterEach(cleanTestData);

afterAll(async () => {
  await cleanTestData();
  await applicationDatabase.close();
  await runtimeDatabase.end();
  await migrationDatabase.end();
  await controlDatabase.unsafe("revoke app_runtime from postgres");
  await controlDatabase.unsafe("revoke app_migrator from postgres");
  await controlDatabase.end();
});

describe("Postgres command receipts", () => {
  it("canonicalizes uppercase UUIDs and replays their lowercase form", async () => {
    const game = await store.createManual("命令收據測試：UUID 正規化", "board_game");
    const uppercaseCommand = { ownerId, commandId: "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD", expectedVersion: 1, gameId: game.id.toUpperCase(), payload: { displayName: "命令收據測試：UUID 已正規化" } } as const;

    await expect(store.editWithCommand(uppercaseCommand)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: false });
    await expect(store.editWithCommand({ ...uppercaseCommand, commandId: uppercaseCommand.commandId.toLowerCase(), gameId: game.id })).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: true });
  });

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

  it("serializes the same command id and replays exactly one committed result", async () => {
    const game = await store.createManual("命令收據測試：同 ID 並行", "board_game");
    const command = { ownerId, commandId: "77777777-7777-4777-8777-777777777777", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：同 ID 完成" } } as const;

    const results = await Promise.all([store.editWithCommand(command), store.editWithCommand(command)]);

    expect(results).toEqual(expect.arrayContaining([
      { resourceId: game.id, version: 2, state: "active", replayed: false },
      { resourceId: game.id, version: 2, state: "active", replayed: true },
    ]));
    await expect(store.get(game.id)).resolves.toMatchObject({ displayName: "命令收據測試：同 ID 完成", version: 2 });
    await expect(runtimeDatabase.unsafe("select count(*)::int as count from app_private.command_receipts where command_id = $1", [command.commandId])).resolves.toEqual([{ count: 1 }]);
  });

  it("rolls back content, version, and receipt when receipt completion fails, then accepts the original retry", async () => {
    const game = await store.createManual("命令收據測試：尾端回滾", "board_game");
    const command = { ownerId, commandId: "88888888-8888-4888-8888-888888888888", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：尾端回滾完成", tags: ["應共同回滾"] } } as const;
    await migrationDatabase.unsafe(`
      create function app_private.command_receipts_test_failure()
      returns trigger language plpgsql as $$
      begin
        if new.owner_id = '${ownerId}' and new.result_version is not null then
          raise exception 'command receipt completion failure';
        end if;
        return new;
      end;
      $$
    `);
    await migrationDatabase.unsafe("create trigger command_receipts_test_failure before update of result_version on app_private.command_receipts for each row execute function app_private.command_receipts_test_failure()");

    await expect(store.editWithCommand(command)).rejects.toThrow();
    await expect(store.get(game.id)).resolves.toMatchObject({ displayName: "命令收據測試：尾端回滾", tags: [], version: 1 });
    await expect(runtimeDatabase.unsafe("select count(*)::int as count from app_private.command_receipts where command_id = $1", [command.commandId])).resolves.toEqual([{ count: 0 }]);

    await dropReceiptFailure();
    await expect(store.editWithCommand(command)).resolves.toEqual({ resourceId: game.id, version: 2, state: "active", replayed: false });
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

  it("rechecks expiry after a receipt-lock wait crosses the boundary", async () => {
    const game = await store.createManual("命令收據測試：跨界等待", "board_game");
    const command = { ownerId, commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：跨界等待完成" } } as const;
    await store.editWithCommand(command);
    await runtimeDatabase.unsafe(`
      with boundary as (select clock_timestamp() + interval '1 second' as expires_at)
      update app_private.command_receipts
      set created_at = boundary.expires_at - interval '90 days', expires_at = boundary.expires_at
      from boundary where command_id = $1
    `, [command.commandId]);

    let confirmLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = migrationDatabase.begin(async (tx) => {
      await tx.unsafe("select command_id from app_private.command_receipts where command_id = $1 for update", [command.commandId]);
      confirmLocked();
      await release;
    });
    await locked;

    const retry = store.editWithCommand(command).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await expect(Promise.race([
      retry.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ])).resolves.toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    releaseLock();
    await blocker;

    const result = await retry;
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(CommandVersionConflictError);
  });

  it("reclaims the command when cleanup deletes its receipt during lock acquisition", async () => {
    const game = await store.createManual("命令收據測試：清理競態", "board_game");
    const command = { ownerId, commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：清理競態完成" } } as const;
    await store.editWithCommand(command);
    await runtimeDatabase.unsafe("update app_private.command_receipts set created_at = now() - interval '90 days', expires_at = now() where command_id = $1", [command.commandId]);

    let confirmDeleted!: () => void;
    let releaseDelete!: () => void;
    const deleted = new Promise<void>((resolve) => { confirmDeleted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const blocker = migrationDatabase.begin(async (tx) => {
      await tx.unsafe("delete from app_private.command_receipts where command_id = $1", [command.commandId]);
      confirmDeleted();
      await release;
    });
    await deleted;

    const retry = store.editWithCommand(command).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await expect(Promise.race([
      retry.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ])).resolves.toBe("waiting");
    releaseDelete();
    await blocker;

    const result = await retry;
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(CommandVersionConflictError);
  });

  it("stops replay at the 90-day boundary even behind a full cleanup backlog", async () => {
    const game = await store.createManual("命令收據測試：到期邊界", "board_game");
    const expiredCommand = { ownerId, commandId: "99999999-9999-4999-8999-999999999999", expectedVersion: 1, gameId: game.id, payload: { displayName: "命令收據測試：已到期" } } as const;
    await store.editWithCommand(expiredCommand);
    await runtimeDatabase.unsafe("update app_private.command_receipts set created_at = now() - interval '90 days', expires_at = now() where command_id = $1", [expiredCommand.commandId]);
    await runtimeDatabase.unsafe(`
      insert into app_private.command_receipts
        (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256, result_version, result_state, created_at, expires_at)
      select
        (lpad(to_hex(sequence), 8, '0') || '-0000-4000-8000-' || lpad(to_hex(sequence), 12, '0'))::uuid,
        $1, 'game.edit', 'game', $2, 1, repeat('a', 64), 2, 'active',
        now() - interval '91 days' - sequence * interval '1 second',
        now() - interval '1 day' - sequence * interval '1 second'
      from generate_series(1, 100) as sequence
    `, [ownerId, game.id]);

    await expect(store.editWithCommand(expiredCommand)).rejects.toBeInstanceOf(CommandVersionConflictError);

    const next = { ownerId, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedVersion: 2, gameId: game.id, payload: { displayName: "命令收據測試：清理後" } } as const;
    await expect(store.editWithCommand(next)).resolves.toMatchObject({ version: 3, replayed: false });
    await expect(store.cleanupExpiredCommandReceipts(500)).resolves.toBe(1);
    await expect(runtimeDatabase.unsafe("select count(*)::int as count from app_private.command_receipts where command_id = $1", [expiredCommand.commandId])).resolves.toEqual([{ count: 0 }]);
  });
});

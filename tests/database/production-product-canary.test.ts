import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const database = postgres(databaseUrl, { max: 3, prepare: false, connect_timeout: 5 });
const fixedGame = "21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d";

function uuid() {
  return crypto.randomUUID();
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectSqlError(operation: Promise<unknown>, message: string) {
  await expect(operation).rejects.toThrow(message);
}

describe("production product canary fencing on PostgreSQL", () => {
  afterAll(async () => database.end());

  it("serializes cleanup behind an admitted write and keeps rollback recoverable", async () => {
    const firstGeneration = uuid();
    const ownerId = `canary-test-${uuid()}`;
    const commandId = uuid();
    const secondGeneration = uuid();
    const lateCommandId = uuid();
    try {
      const claimed = await database.unsafe(
        "select app_private.claim_production_product_canary($1::uuid, $2) as claimed",
        [firstGeneration, ownerId],
      );
      expect(claimed[0]?.claimed).toBe(true);
      const started = await database.unsafe(
        "select app_private.begin_production_product_canary_command($1::uuid, $2, $3::uuid, 'game.trash', array[$4::uuid]) as started",
        [firstGeneration, ownerId, commandId, fixedGame],
      );
      expect(started[0]?.started).toBe(true);

      let admitted!: () => void;
      const admittedWrite = new Promise<void>((resolve) => { admitted = resolve; });
      const writeTransaction = database.begin(async (transaction) => {
        await transaction.unsafe(
          "select app_private.guard_production_product_canary_command($1::uuid, $2, $3::uuid, 'game.trash', array[$4::uuid])",
          [firstGeneration, ownerId, commandId, fixedGame],
        );
        admitted();
        await delay(160);
        await transaction.unsafe(
          "update app_private.games set trashed_at = clock_timestamp(), version = version + 1 where id = $1::uuid",
          [fixedGame],
        );
      });
      await admittedWrite;
      const cleanupStartedAt = Date.now();
      const prepareWhileLocked = database.unsafe(
        "select app_private.prepare_production_product_canary_cleanup($1::uuid)",
        [firstGeneration],
      );
      const settledBeforeCommit = await Promise.race([
        prepareWhileLocked.then(() => true, () => true),
        delay(50).then(() => false),
      ]);
      expect(settledBeforeCommit).toBe(false);
      await writeTransaction;
      await expectSqlError(prepareWhileLocked, "canary_command_requires_recovery");
      expect(Date.now() - cleanupStartedAt).toBeGreaterThanOrEqual(120);
      await database.unsafe(
        "select app_private.complete_production_product_canary_command($1::uuid, $2::uuid)",
        [firstGeneration, commandId],
      );
      const trashed = await database.unsafe(
        "select trashed_at from app_private.games where id = $1::uuid",
        [fixedGame],
      );
      expect(trashed[0]?.trashed_at).not.toBeNull();

      await database.unsafe(
        "select app_private.prepare_production_product_canary_cleanup($1::uuid)",
        [firstGeneration],
      );
      await database.unsafe(
        "select * from app_private.cleanup_production_product_canary($1::uuid)",
        [firstGeneration],
      );

      const secondClaim = await database.unsafe(
        "select app_private.claim_production_product_canary($1::uuid, $2) as claimed",
        [secondGeneration, ownerId],
      );
      expect(secondClaim[0]?.claimed).toBe(true);
      await database.unsafe(
        "select app_private.begin_production_product_canary_command($1::uuid, $2, $3::uuid, 'game.trash', array[$4::uuid])",
        [secondGeneration, ownerId, lateCommandId, fixedGame],
      );
      const pending = await database.unsafe("select deadline_at from app_private.inspect_production_product_canary()");
      const remainingMs = new Date(String(pending[0]?.deadline_at)).getTime() - Date.now();
      if (remainingMs > 0) await delay(remainingMs + 1_000);
      await expectSqlError(database.unsafe(
        "select app_private.guard_production_product_canary_command($1::uuid, $2, $3::uuid, 'game.trash', array[$4::uuid])",
        [secondGeneration, ownerId, lateCommandId, fixedGame],
      ), "canary_command_expired");
      await expectSqlError(database.unsafe(
        "select app_private.guard_production_product_canary_command($1::uuid, $2, $3::uuid, 'game.trash', array[$4::uuid])",
        [firstGeneration, ownerId, lateCommandId, fixedGame],
      ), "canary_command_rejected");
      await database.unsafe(
        "select app_private.require_production_product_canary_recovery($1::uuid, $2::uuid)",
        [secondGeneration, lateCommandId],
      );
      await database.unsafe(
        "select app_private.prepare_production_product_canary_cleanup($1::uuid)",
        [secondGeneration],
      );
      await expect(database.begin(async (transaction) => {
        await transaction.unsafe(
          "select * from app_private.cleanup_production_product_canary($1::uuid)",
          [secondGeneration],
        );
        throw new Error("inject cleanup transaction rollback");
      })).rejects.toThrow("inject cleanup transaction rollback");
      const retained = await database.unsafe(
        "select phase, game_count as games from app_private.inspect_production_product_canary() where generation = $1::uuid",
        [secondGeneration],
      );
      expect(retained[0]?.phase).toBe("cleanup_pending");
      expect(Number(retained[0]?.games)).toBe(2);
      await database.unsafe(
        "select * from app_private.cleanup_production_product_canary($1::uuid)",
        [secondGeneration],
      );
      const residue = await database.unsafe(
        "select (select count(*) from app_private.games where is_production_canary) as games, (select count(*) from app_private.inspect_production_product_canary()) as registry",
      );
      expect(Number(residue[0]?.games)).toBe(0);
      expect(Number(residue[0]?.registry)).toBe(0);
    } finally {
      const registry = await database.unsafe(
        "select generation, phase, command_id, deadline_at from app_private.inspect_production_product_canary()",
      );
      const generation = registry[0]?.generation;
      if (typeof generation === "string") {
        if (registry[0]?.phase === "request_pending") {
          const remainingMs = new Date(String(registry[0]?.deadline_at)).getTime() - Date.now();
          if (remainingMs > 0) await delay(remainingMs + 100);
          await database.unsafe(
            "select app_private.require_production_product_canary_recovery($1::uuid, $2::uuid)",
            [generation, registry[0]?.command_id],
          );
        }
        await database.unsafe("select app_private.prepare_production_product_canary_cleanup($1::uuid)", [generation]);
        await database.unsafe("select * from app_private.cleanup_production_product_canary($1::uuid)", [generation]);
      }
    }
  }, 45_000);
});

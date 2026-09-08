import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CommandIdempotencyConflictError,
  CommandTargetNotFoundError,
  commandPayloadSha256,
} from "@/modules/commands";
import {
  NoteGameUnavailableError,
  NoteStateConflictError,
  NoteVersionConflictError,
  type CreateNoteCommand,
  type NoteCommandResult,
  type NoteLifecycleCommand,
  type NoteRecord,
  type NoteState,
  type NoteStore,
  type UpdateNoteCommand,
} from "@/modules/notes";
import type { ProductionExecutor, QueryExecutor } from "./database-game-store";

type Row = Readonly<Record<string, unknown>>;
type CommandKind = "note.create" | "note.update" | "note.remove" | "note.restore";
type Binding = Readonly<{
  ownerId: string;
  commandId: string;
  commandKind: CommandKind;
  targetKind: "game" | "note";
  targetId: string;
  expectedVersion: number | null;
  payload: unknown;
}>;

function record(row: Row): NoteRecord {
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    content: String(row.content),
    version: Number(row.version),
    state: row.removed_at === null ? "active" : "removed",
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

const noteFields = sql`id, game_id, content, version, removed_at, created_at, updated_at`;

export class PostgresNoteStore implements NoteStore {
  constructor(private readonly db: ProductionExecutor) {}

  async list(gameId: string): Promise<readonly NoteRecord[]> {
    const rows = await this.db.execute(sql`
      select note.id, note.game_id, note.content, note.version, note.removed_at, note.created_at, note.updated_at
      from app_private.notes note
      join app_private.games game on game.id = note.game_id
      where note.game_id = ${gameId.toLowerCase()} and note.removed_at is null and game.trashed_at is null
      order by note.created_at, note.id
    `) as Row[];
    return rows.map(record);
  }

  create(command: CreateNoteCommand) {
    const noteId = randomUUID();
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, commandKind: "note.create", targetKind: "game", targetId: command.gameId, expectedVersion: null, payload: { content: command.content } }, async (tx) => {
      const games = await tx.execute(sql`select id from app_private.games where id = ${command.gameId.toLowerCase()} and trashed_at is null for update`) as Row[];
      if (!games[0]) throw new NoteGameUnavailableError();
      const rows = await tx.execute(sql`insert into app_private.notes (id, game_id, content) values (${noteId}, ${command.gameId.toLowerCase()}, ${command.content}) returning ${noteFields}`) as Row[];
      if (!rows[0]) throw new CommandTargetNotFoundError();
      return record(rows[0]);
    });
  }

  update(command: UpdateNoteCommand) {
    return this.mutate("note.update", command, { content: command.content }, async (tx, current) => {
      const rows = await tx.execute(sql`update app_private.notes set content = ${command.content}, version = version + 1, updated_at = clock_timestamp() where id = ${current.id} returning ${noteFields}`) as Row[];
      return record(rows[0]!);
    });
  }

  remove(command: NoteLifecycleCommand) {
    return this.mutate("note.remove", command, {}, async (tx, current) => {
      if (current.state !== "active") throw new NoteStateConflictError(current);
      const rows = await tx.execute(sql`update app_private.notes set removed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp() where id = ${current.id} returning ${noteFields}`) as Row[];
      return record(rows[0]!);
    });
  }

  restore(command: NoteLifecycleCommand) {
    return this.mutate("note.restore", command, {}, async (tx, current) => {
      if (current.state !== "removed") throw new NoteStateConflictError(current);
      const rows = await tx.execute(sql`update app_private.notes set removed_at = null, version = version + 1, updated_at = clock_timestamp() where id = ${current.id} returning ${noteFields}`) as Row[];
      return record(rows[0]!);
    });
  }

  private mutate(
    kind: Exclude<CommandKind, "note.create">,
    command: UpdateNoteCommand | NoteLifecycleCommand,
    payload: unknown,
    mutation: (tx: QueryExecutor, current: NoteRecord) => Promise<NoteRecord>,
  ) {
    return this.execute({ ownerId: command.ownerId, commandId: command.commandId, commandKind: kind, targetKind: "note", targetId: command.noteId, expectedVersion: command.expectedVersion, payload }, async (tx) => {
      const rows = await tx.execute(sql`select ${noteFields} from app_private.notes where id = ${command.noteId.toLowerCase()} for update`) as Row[];
      if (!rows[0]) throw new CommandTargetNotFoundError();
      const current = record(rows[0]);
      const games = await tx.execute(sql`select trashed_at from app_private.games where id = ${current.gameId} for update`) as Row[];
      if (!games[0] || games[0].trashed_at !== null) throw new NoteGameUnavailableError();
      if (current.version !== command.expectedVersion) throw new NoteVersionConflictError(current);
      if (kind === "note.update" && current.state !== "active") throw new NoteStateConflictError(current);
      return mutation(tx, current);
    });
  }

  private async execute(binding: Binding, mutation: (tx: QueryExecutor) => Promise<NoteRecord>): Promise<NoteCommandResult> {
    const commandId = binding.commandId.toLowerCase();
    const targetId = binding.targetId.toLowerCase();
    const digest = commandPayloadSha256(binding.payload);
    return this.db.transaction(async (tx) => {
      let rows = await tx.execute(sql`select * from app_private.note_command_receipts where command_id = ${commandId} for update`) as Row[];
      let receipt = rows[0];
      let claimed = false;
      if (!receipt) {
        rows = await tx.execute(sql`
          insert into app_private.note_command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256)
          values (${commandId}, ${binding.ownerId}, ${binding.commandKind}, ${binding.targetKind}, ${targetId}, ${binding.expectedVersion}, ${digest})
          on conflict (command_id) do nothing returning *
        `) as Row[];
        receipt = rows[0];
        claimed = Boolean(receipt);
        if (!receipt) {
          rows = await tx.execute(sql`select * from app_private.note_command_receipts where command_id = ${commandId} for update`) as Row[];
          receipt = rows[0];
        }
      }
      if (!receipt) throw new CommandTargetNotFoundError();
      if (!claimed && receipt.result_version !== null) {
        const expiry = await tx.execute(sql`select expires_at <= clock_timestamp() as expired from app_private.note_command_receipts where command_id = ${commandId}`) as Row[];
        if (expiry[0]?.expired === true) {
          await tx.execute(sql`delete from app_private.note_command_receipts where command_id = ${commandId}`);
          rows = await tx.execute(sql`
            insert into app_private.note_command_receipts (command_id, owner_id, command_kind, target_kind, target_id, expected_version, payload_sha256)
            values (${commandId}, ${binding.ownerId}, ${binding.commandKind}, ${binding.targetKind}, ${targetId}, ${binding.expectedVersion}, ${digest}) returning *
          `) as Row[];
          receipt = rows[0];
          claimed = true;
        }
      }
      if (!receipt || String(receipt.owner_id) !== binding.ownerId || receipt.command_kind !== binding.commandKind || receipt.target_kind !== binding.targetKind || String(receipt.target_id) !== targetId || (receipt.expected_version === null ? null : Number(receipt.expected_version)) !== binding.expectedVersion || receipt.payload_sha256 !== digest) throw new CommandIdempotencyConflictError();
      await this.cleanup(tx, 100, commandId);
      if (!claimed && receipt.result_id && receipt.result_version !== null && receipt.result_state) {
        return { resourceId: String(receipt.result_id), version: Number(receipt.result_version), state: receipt.result_state as NoteState, replayed: true };
      }
      const note = await mutation(tx);
      await tx.execute(sql`update app_private.note_command_receipts set result_id = ${note.id}, result_version = ${note.version}, result_state = ${note.state} where command_id = ${commandId}`);
      return { resourceId: note.id, version: note.version, state: note.state, replayed: false };
    });
  }

  private async cleanup(tx: QueryExecutor, limit: number, excludedCommandId: string) {
    await tx.execute(sql`
      with expired as (
        select command_id from app_private.note_command_receipts
        where command_id <> ${excludedCommandId} and expires_at <= clock_timestamp() and result_version is not null
        order by expires_at, command_id limit ${limit} for update skip locked
      )
      delete from app_private.note_command_receipts receipt using expired where receipt.command_id = expired.command_id
    `);
  }
}

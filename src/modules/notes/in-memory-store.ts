import { randomUUID } from "node:crypto";
import { CommandIdempotencyConflictError, CommandTargetNotFoundError, commandPayloadSha256 } from "@/modules/commands";
import { NoteStateConflictError, NoteVersionConflictError, type CreateNoteCommand, type NoteCommandResult, type NoteLifecycleCommand, type NoteRecord, type NoteStore, type UpdateNoteCommand } from ".";

type Receipt = Readonly<{ binding: string; result: NoteCommandResult }>;

export class InMemoryNoteStore implements NoteStore {
  private readonly notes = new Map<string, NoteRecord>();
  private readonly receipts = new Map<string, Receipt>();

  async list(gameId: string) {
    return [...this.notes.values()].filter((note) => note.gameId === gameId && note.state === "active").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(command: CreateNoteCommand) {
    return this.run(command.commandId, [command.ownerId, "note.create", command.gameId, commandPayloadSha256({ content: command.content })], () => {
      const now = new Date().toISOString();
      const note = { id: randomUUID(), gameId: command.gameId, content: command.content, version: 1, state: "active" as const, createdAt: now, updatedAt: now };
      this.notes.set(note.id, note);
      return note;
    });
  }

  async update(command: UpdateNoteCommand) {
    return this.change("note.update", command, { content: command.content }, (note) => ({ ...note, content: command.content, version: note.version + 1, updatedAt: new Date().toISOString() }));
  }

  async remove(command: NoteLifecycleCommand) {
    return this.change("note.remove", command, {}, (note) => {
      if (note.state !== "active") throw new NoteStateConflictError(note);
      return { ...note, version: note.version + 1, state: "removed" as const, updatedAt: new Date().toISOString() };
    });
  }

  async restore(command: NoteLifecycleCommand) {
    return this.change("note.restore", command, {}, (note) => {
      if (note.state !== "removed") throw new NoteStateConflictError(note);
      return { ...note, version: note.version + 1, state: "active" as const, updatedAt: new Date().toISOString() };
    });
  }

  private change(kind: string, command: NoteLifecycleCommand, payload: unknown, mutation: (note: NoteRecord) => NoteRecord) {
    return this.run(command.commandId, [command.ownerId, kind, command.noteId, command.expectedVersion, commandPayloadSha256(payload)], () => {
      const note = this.notes.get(command.noteId);
      if (!note) throw new CommandTargetNotFoundError();
      if (note.version !== command.expectedVersion) throw new NoteVersionConflictError(note);
      const updated = mutation(note);
      this.notes.set(note.id, updated);
      return updated;
    });
  }

  private async run(commandId: string, parts: readonly unknown[], mutation: () => NoteRecord): Promise<NoteCommandResult> {
    const binding = JSON.stringify(parts);
    const receipt = this.receipts.get(commandId);
    if (receipt) {
      if (receipt.binding !== binding) throw new CommandIdempotencyConflictError();
      return { ...receipt.result, replayed: true };
    }
    const note = mutation();
    const result = { resourceId: note.id, version: note.version, state: note.state, replayed: false };
    this.receipts.set(commandId, { binding, result });
    return result;
  }
}

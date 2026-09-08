import { NamedError } from "@/shared/errors/named-error";

export type NoteState = "active" | "removed";

export type NoteRecord = Readonly<{
  id: string;
  gameId: string;
  content: string;
  version: number;
  state: NoteState;
  createdAt: string;
  updatedAt: string;
}>;

type BaseCommand = Readonly<{ ownerId: string; commandId: string }>;
export type CreateNoteCommand = BaseCommand & Readonly<{ gameId: string; content: string }>;
export type UpdateNoteCommand = BaseCommand & Readonly<{ noteId: string; expectedVersion: number; content: string }>;
export type NoteLifecycleCommand = BaseCommand & Readonly<{ noteId: string; expectedVersion: number }>;
export type NoteCommandResult = Readonly<{ resourceId: string; version: number; state: NoteState; replayed: boolean }>;

export type NoteStore = Readonly<{
  list(gameId: string): Promise<readonly NoteRecord[]>;
  create(command: CreateNoteCommand): Promise<NoteCommandResult>;
  update(command: UpdateNoteCommand): Promise<NoteCommandResult>;
  remove(command: NoteLifecycleCommand): Promise<NoteCommandResult>;
  restore(command: NoteLifecycleCommand): Promise<NoteCommandResult>;
}>;

export class NoteContentBlankError extends NamedError {
  constructor() {
    super("note_content_blank", "筆記內容不可為空白；若要移除既有筆記，請先確認移除。");
    this.name = "NoteContentBlankError";
  }
}

export class NoteGameUnavailableError extends NamedError {
  constructor() {
    super("note_game_unavailable", "遊戲不存在或已移入資源回收區，無法編輯筆記。");
    this.name = "NoteGameUnavailableError";
  }
}

export class NoteStateConflictError extends NamedError {
  constructor(readonly current: NoteRecord) {
    super("note_state_conflict", current.state === "removed" ? "筆記已移除，請先還原。" : "筆記目前不是可還原狀態。");
    this.name = "NoteStateConflictError";
  }
}

export class NoteVersionConflictError extends NamedError {
  constructor(readonly current: NoteRecord) {
    super("command_version_conflict", "筆記已在其他頁面更新；你的文字仍保留，請選擇要載入或重送。");
    this.name = "NoteVersionConflictError";
  }
}

export function createNotesService(store: NoteStore) {
  const nonblank = <Command extends { content: string }>(command: Command): Command => {
    if (!command.content.trim()) throw new NoteContentBlankError();
    return command;
  };
  return {
    list: (gameId: string) => store.list(gameId),
    create: async (command: CreateNoteCommand) => store.create(nonblank(command)),
    update: async (command: UpdateNoteCommand) => store.update(nonblank(command)),
    remove: (command: NoteLifecycleCommand) => store.remove(command),
    restore: (command: NoteLifecycleCommand) => store.restore(command),
  } as const;
}

export type NotesService = ReturnType<typeof createNotesService>;

export { InMemoryNoteStore } from "./in-memory-store";

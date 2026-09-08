import { describe, expect, it, vi } from "vitest";
import {
  NoteContentBlankError,
  createNotesService,
  type NoteRecord,
  type NoteStore,
} from ".";

const note: NoteRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  gameId: "20000000-0000-4000-8000-000000000001",
  content: "第一則筆記",
  version: 1,
  state: "active",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

function store(overrides: Partial<NoteStore> = {}): NoteStore {
  return {
    list: vi.fn(async () => [note]),
    create: vi.fn(async () => ({ resourceId: note.id, version: 1, state: "active" as const, replayed: false })),
    update: vi.fn(async () => ({ resourceId: note.id, version: 2, state: "active" as const, replayed: false })),
    remove: vi.fn(async () => ({ resourceId: note.id, version: 2, state: "removed" as const, replayed: false })),
    restore: vi.fn(async () => ({ resourceId: note.id, version: 3, state: "active" as const, replayed: false })),
    ...overrides,
  };
}

describe("NotesService", () => {
  it("空白新筆記不交給 store 持久化", async () => {
    const notes = store();
    const service = createNotesService(notes);

    await expect(service.create({ ownerId: "owner", commandId: crypto.randomUUID(), gameId: note.gameId, content: "  \n " }))
      .rejects.toBeInstanceOf(NoteContentBlankError);
    expect(notes.create).not.toHaveBeenCalled();
  });

  it("非空筆記保留使用者原始 Markdown，只以 trim 判斷空白", async () => {
    const notes = store();
    const service = createNotesService(notes);

    await service.create({ ownerId: "owner", commandId: crypto.randomUUID(), gameId: note.gameId, content: "  **重要**  " });

    expect(notes.create).toHaveBeenCalledWith(expect.objectContaining({ content: "  **重要**  " }));
  });

  it("更新空白內容拒絕且不隱含移除", async () => {
    const notes = store();
    const service = createNotesService(notes);

    await expect(service.update({ ownerId: "owner", commandId: crypto.randomUUID(), noteId: note.id, expectedVersion: 1, content: "" }))
      .rejects.toBeInstanceOf(NoteContentBlankError);
    expect(notes.update).not.toHaveBeenCalled();
    expect(notes.remove).not.toHaveBeenCalled();
  });

  it("移除與還原是不同的明確命令", async () => {
    const notes = store();
    const service = createNotesService(notes);

    await service.remove({ ownerId: "owner", commandId: crypto.randomUUID(), noteId: note.id, expectedVersion: 1 });
    await service.restore({ ownerId: "owner", commandId: crypto.randomUUID(), noteId: note.id, expectedVersion: 2 });

    expect(notes.remove).toHaveBeenCalledOnce();
    expect(notes.restore).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createPrivateNoteAdapter } from "@/app/private-note-adapter";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import type { PrivateActionDependencies } from "@/shared/auth/private-action";
import { NoteVersionConflictError, type NoteRecord, type NotesService } from "@/modules/notes";

const requestId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const gameId = "33333333-3333-4333-8333-333333333333";
const noteId = "44444444-4444-4444-8444-444444444444";
const current: NoteRecord = { id: noteId, gameId, content: "伺服器內容", version: 7, state: "active", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:01:00.000Z" };

function setup(authorized = true) {
  const notesService: NotesService = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ resourceId: noteId, version: 1, state: "active" as const, replayed: false })),
    update: vi.fn(async () => ({ resourceId: noteId, version: 2, state: "active" as const, replayed: false })),
    remove: vi.fn(async () => ({ resourceId: noteId, version: 2, state: "removed" as const, replayed: false })),
    restore: vi.fn(async () => ({ resourceId: noteId, version: 3, state: "active" as const, replayed: false })),
  };
  const dependencies: PrivateActionDependencies = {
    verifyAccessToken: vi.fn(async () => {
      if (!authorized) throw new AccessDeniedError();
      return { sub: "owner-subject" };
    }),
    onAccessDenied: vi.fn(async () => undefined),
    onUnhandledFailure: vi.fn(async () => undefined),
  };
  const adapter = createPrivateNoteAdapter({
    getHeaders: async () => new Headers({ "Cf-Access-Jwt-Assertion": "token", "x-request-id": requestId }),
    getPrivateDependencies: () => dependencies,
    notesService,
  });
  return { adapter, dependencies, notesService };
}

describe("private note adapter", () => {
  it("completes owner authentication before calling the note service", async () => {
    const { adapter, notesService } = setup(false);
    const result = await adapter.create({ commandId, gameId, content: "私密筆記" });
    expect(result).toEqual({ ok: false, code: "access_denied", message: "無法驗證存取權限。", requestId });
    expect(notesService.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("私密筆記");
  });

  it("canonicalizes ids and returns the command result without owner identity", async () => {
    const { adapter, notesService } = setup();
    const result = await adapter.create({ commandId: commandId.toUpperCase(), gameId: gameId.toUpperCase(), content: "**原文**" });
    expect(result).toEqual({ ok: true, resourceId: noteId, version: 1, state: "active", replayed: false });
    expect(notesService.create).toHaveBeenCalledWith({ ownerId: "owner-subject", commandId, gameId, content: "**原文**" });
    expect(JSON.stringify(result)).not.toContain("owner-subject");
  });

  it("returns current server content for an actionable stale-writer conflict", async () => {
    const { adapter, notesService, dependencies } = setup();
    vi.mocked(notesService.update).mockRejectedValueOnce(new NoteVersionConflictError(current));
    const result = await adapter.update({ commandId, noteId, expectedVersion: 1, content: "我的內容" });
    expect(result).toEqual({ ok: false, code: "command_version_conflict", message: "筆記已在其他頁面更新；你的文字仍保留，請選擇要載入或重送。", requestId, currentVersion: 7, currentState: "active", currentNote: current });
    expect(dependencies.onUnhandledFailure).not.toHaveBeenCalled();
  });

  it("rejects blank and malformed requests before service persistence", async () => {
    const { adapter, notesService } = setup();
    const result = await adapter.update({ commandId, noteId, expectedVersion: 0, content: "x" });
    expect(result).toEqual({ ok: false, code: "invalid_input", message: "筆記參數無效。", requestId });
    expect(notesService.update).not.toHaveBeenCalled();
  });
});

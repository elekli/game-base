import { z } from "zod";
import type { NoteCommandResult, NotesService } from "@/modules/notes";
import { handlePrivateAction, type PrivateActionDependencies } from "@/shared/auth/private-action";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const createSchema = z.object({ commandId: uuid, gameId: uuid, content: z.string().max(100_000) });
const updateSchema = z.object({ commandId: uuid, noteId: uuid, expectedVersion: z.number().int().positive(), content: z.string().max(100_000) });
const lifecycleSchema = z.object({ commandId: uuid, noteId: uuid, expectedVersion: z.number().int().positive() });

export function createPrivateNoteAdapter(input: Readonly<{
  getHeaders: () => Promise<Headers>;
  getPrivateDependencies: () => PrivateActionDependencies;
  notesService: NotesService;
}>) {
  const boundary = <Value,>(value: unknown, schema: z.ZodType<Value>, operation: (parsed: Value, ownerId: string) => Promise<NoteCommandResult>) => input.getHeaders().then((headers) => handlePrivateAction(headers, {
    ...input.getPrivateDependencies(), input: value, schema, inputErrorMessage: "筆記參數無效。",
    operation: async (owner, parsed) => operation(parsed, owner.sub),
  }));
  return {
    create: (value: unknown) => boundary(value, createSchema, (parsed, ownerId) => input.notesService.create({ ...parsed, ownerId })),
    update: (value: unknown) => boundary(value, updateSchema, (parsed, ownerId) => input.notesService.update({ ...parsed, ownerId })),
    remove: (value: unknown) => boundary(value, lifecycleSchema, (parsed, ownerId) => input.notesService.remove({ ...parsed, ownerId })),
    restore: (value: unknown) => boundary(value, lifecycleSchema, (parsed, ownerId) => input.notesService.restore({ ...parsed, ownerId })),
  };
}

import { z } from "zod";
import type { NoteCommandResult, NotesService } from "@/modules/notes";
import { handlePrivateAction, type PrivateActionDependencies } from "@/shared/auth/private-action";
import { attachProductionCanaryExecutionSha, withProductionProductCanaryMutation, productionCanaryNoteMutationTarget } from "@/app/production-canary/owner-mutation";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const createSchema = z.object({ commandId: uuid, gameId: uuid, content: z.string().max(100_000) });
const updateSchema = z.object({ commandId: uuid, noteId: uuid, expectedVersion: z.number().int().positive(), content: z.string().max(100_000) });
const lifecycleSchema = z.object({ commandId: uuid, noteId: uuid, expectedVersion: z.number().int().positive() });

export function createPrivateNoteAdapter(input: Readonly<{
  getHeaders: () => Promise<Headers>;
  getPrivateDependencies: () => PrivateActionDependencies;
  notesService: NotesService;
}>) {
  const boundary = <Value,>(value: unknown, schema: z.ZodType<Value>, operation: (parsed: Value, ownerId: string) => Promise<NoteCommandResult>, canary?: (parsed: Value) => { commandId: string; operation: "note.create" | "note.update" | "note.remove" | "note.restore"; targetIds: readonly string[] }) => input.getHeaders().then(async (headers) => attachProductionCanaryExecutionSha(headers, await handlePrivateAction(headers, {
    ...input.getPrivateDependencies(), input: value, schema, inputErrorMessage: "筆記參數無效。",
    operation: async (owner, parsed) => {
      const execute = () => operation(parsed, owner.sub);
      const scope = canary?.(parsed);
      return scope ? withProductionProductCanaryMutation({ headers, ownerId: owner.sub, ...scope, execute }) : execute();
    },
  })));
  return {
    create: (value: unknown) => boundary(value, createSchema, (parsed, ownerId) => input.notesService.create({ ...parsed, ownerId }), (parsed) => ({ commandId: parsed.commandId, operation: "note.create", targetIds: [parsed.gameId] })),
    update: (value: unknown) => boundary(value, updateSchema, (parsed, ownerId) => input.notesService.update({ ...parsed, ownerId }), (parsed) => ({ commandId: parsed.commandId, operation: "note.update", targetIds: [productionCanaryNoteMutationTarget(parsed)] })),
    remove: (value: unknown) => boundary(value, lifecycleSchema, (parsed, ownerId) => input.notesService.remove({ ...parsed, ownerId }), (parsed) => ({ commandId: parsed.commandId, operation: "note.remove", targetIds: [productionCanaryNoteMutationTarget(parsed)] })),
    restore: (value: unknown) => boundary(value, lifecycleSchema, (parsed, ownerId) => input.notesService.restore({ ...parsed, ownerId }), (parsed) => ({ commandId: parsed.commandId, operation: "note.restore", targetIds: [productionCanaryNoteMutationTarget(parsed)] })),
  };
}

import { z } from "zod";
import { externalGameRefSchema } from "@/app/external-game-ref-schema";
import type { GamesService } from "@/modules/games";
import type { RelationsService, RelationTarget } from "@/modules/relations";
import type { ExternalReferenceThumbnailService } from "@/modules/lists/external-reference-thumbnail";
import { handlePrivateAction, type PrivateActionDependencies } from "@/shared/auth/private-action";
import { getRequestId } from "@/shared/observability/request-id";
import { attachProductionCanaryExecutionSha, withProductionProductCanaryMutation } from "@/app/production-canary/owner-mutation";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const target = z.discriminatedUnion("kind", [z.object({ kind: z.literal("game"), gameId: uuid }), z.object({ kind: z.literal("external"), ref: externalGameRefSchema })]);
const add = z.object({ commandId: uuid, left: target, right: target });
const command = z.object({ commandId: uuid, relationId: uuid, expectedVersion: z.number().int().positive() });
const describe = command.extend({ description: z.string().max(1000).nullable() });
const search = z.object({ query: z.string().trim().min(1).max(120) });

export function createPrivateRelationAdapter(input: Readonly<{ getHeaders: () => Promise<Headers>; getPrivateDependencies: () => PrivateActionDependencies; relationsService: RelationsService; gamesService: GamesService; externalThumbnailService?: ExternalReferenceThumbnailService | null; onExternalThumbnailFailure?: (requestId: string) => void | Promise<void> }>) {
  const boundary = <Value, Success extends object>(value: unknown, schema: z.ZodType<Value>, operation: (parsed: Value, ownerId: string, requestId: string) => Promise<Success>, canary?: (parsed: Value) => { commandId: string; targetIds: readonly string[] }) => input.getHeaders().then(async (headers) => attachProductionCanaryExecutionSha(headers, await handlePrivateAction(headers, {
    ...input.getPrivateDependencies(), input: value, schema, inputErrorMessage: "關聯參數無效。",
    operation: async (owner, parsed) => {
      const execute = () => operation(parsed, owner.sub, getRequestId(headers));
      const scope = canary?.(parsed);
      return scope ? withProductionProductCanaryMutation({ headers, ownerId: owner.sub, operation: "relation.add", ...scope, execute }) : execute();
    },
  })));
  const verifiedTarget = async (candidate: z.infer<typeof target>): Promise<{ target: RelationTarget; coverUrl: string | null }> => {
    if (candidate.kind === "game") return { target: candidate, coverUrl: null };
    const confirmation = await input.gamesService.getExternalGameConfirmation({ ref: candidate.ref });
    return { target: { kind: "external", ref: candidate.ref, name: confirmation.snapshot.title, releaseYear: confirmation.snapshot.releaseYear }, coverUrl: confirmation.snapshot.coverUrl };
  };
  const persistThumbnail = async (verified: Awaited<ReturnType<typeof verifiedTarget>>, requestId: string) => {
    if (verified.target.kind !== "external" || !input.externalThumbnailService) return;
    try { await input.externalThumbnailService.ensure(verified.target.ref, verified.coverUrl); }
    catch {
      try { await input.onExternalThumbnailFailure?.(requestId); }
      catch { console.error("external_reference_thumbnail_observer_failed"); }
    }
  };
  return {
    search: (value: unknown) => boundary(value, search, async (parsed) => input.gamesService.searchExternalGames({ query: parsed.query })),
    add: (value: unknown) => boundary(value, add, async (parsed, ownerId, requestId) => {
      const [left, right] = await Promise.all([verifiedTarget(parsed.left), verifiedTarget(parsed.right)]);
      const result = await input.relationsService.add({ ...parsed, left: left.target, right: right.target, ownerId });
      await Promise.all([persistThumbnail(left, requestId), persistThumbnail(right, requestId)]);
      return result;
    }, (parsed) => ({ commandId: parsed.commandId, targetIds: [parsed.left, parsed.right].flatMap((target) => target.kind === "game" ? [target.gameId] : []) })),
    remove: (value: unknown) => boundary(value, command, (parsed, ownerId) => input.relationsService.remove({ ...parsed, ownerId })),
    restore: (value: unknown) => boundary(value, command, (parsed, ownerId) => input.relationsService.restore({ ...parsed, ownerId })),
    describe: (value: unknown) => boundary(value, describe, (parsed, ownerId) => input.relationsService.describe({ ...parsed, ownerId })),
  };
}

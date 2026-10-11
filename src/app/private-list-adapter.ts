import { z } from "zod";
import { externalGameRefSchema } from "@/app/external-game-ref-schema";
import type { ListsService } from "@/modules/lists";
import type { GamesService } from "@/modules/games";
import { handlePrivateAction, type PrivateActionDependencies } from "@/shared/auth/private-action";
import { ExternalReferenceThumbnailUnavailableError, type ExternalReferenceThumbnailService } from "@/modules/lists/external-reference-thumbnail";
import { getRequestId } from "@/shared/observability/request-id";
import { attachProductionCanaryExecutionSha, withProductionProductCanaryMutation } from "@/app/production-canary/owner-mutation";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("game"), gameId: uuid }),
  z.object({ kind: z.literal("external"), ref: externalGameRefSchema, name: z.string().trim().min(1).max(240), releaseYear: z.number().int().min(0).max(9999).nullable() }),
]);
const create = z.object({ commandId: uuid, name: z.string().max(240), firstMember: target });
const add = z.object({ commandId: uuid, listId: uuid, expectedVersion: z.number().int().positive(), member: target });
const list = z.object({ commandId: uuid, listId: uuid, expectedVersion: z.number().int().positive() });
const member = z.object({ commandId: uuid, memberId: uuid, expectedVersion: z.number().int().positive() });
const describe = member.extend({ description: z.string().max(1000).nullable() });
const retryThumbnail = z.object({ ref: externalGameRefSchema });

export function createPrivateListAdapter(input: Readonly<{ getHeaders: () => Promise<Headers>; getPrivateDependencies: () => PrivateActionDependencies; listsService: ListsService; gamesService: GamesService; externalThumbnailService?: ExternalReferenceThumbnailService | null; onExternalThumbnailFailure?: (requestId: string) => void | Promise<void> }>) {
  const verifiedTarget = async <Target extends { kind: string }>(candidate: Target): Promise<{ target: Target; coverUrl: string | null }> => {
    if (candidate.kind !== "external") return { target: candidate, coverUrl: null };
    const external = candidate as Target & { ref: { provider: "bgg" | "igdb"; medium: "board_game" | "video_game"; sourceId: string }; name: string; releaseYear: number | null };
    const confirmation = await input.gamesService.getExternalGameConfirmation({ ref: external.ref as Parameters<GamesService["getExternalGameConfirmation"]>[0]["ref"] });
    return { target: { ...external, name: confirmation.snapshot.title, releaseYear: confirmation.snapshot.releaseYear } as Target, coverUrl: confirmation.snapshot.coverUrl };
  };
  const persistThumbnail = async (verified: { target: { kind: string }; coverUrl: string | null }, requestId: string) => {
    if (verified.target.kind !== "external" || !input.externalThumbnailService) return;
    try {
      const target = verified.target as unknown as { ref: Parameters<ExternalReferenceThumbnailService["ensure"]>[0] };
      await input.externalThumbnailService.ensure(target.ref, verified.coverUrl);
    } catch {
      try { await input.onExternalThumbnailFailure?.(requestId); }
      catch { console.error("external_reference_thumbnail_observer_failed"); }
    }
  };
  const boundary = <Value, Success extends object>(value: unknown, schema: z.ZodType<Value>, operation: (parsed: Value, ownerId: string, requestId: string) => Promise<Success>, canary?: (parsed: Value) => { commandId: string; targetIds: readonly string[] }) => input.getHeaders().then(async (headers) => attachProductionCanaryExecutionSha(headers, await handlePrivateAction(headers, {
    ...input.getPrivateDependencies(), input: value, schema, inputErrorMessage: "清單參數無效。",
    operation: async (owner, parsed) => {
      const execute = () => operation(parsed, owner.sub, getRequestId(headers));
      const scope = canary?.(parsed);
      return scope ? withProductionProductCanaryMutation({ headers, ownerId: owner.sub, operation: "list.create", ...scope, execute }) : execute();
    },
  })));
  return {
    create: (value: unknown) => boundary(value, create, async (parsed, ownerId, requestId) => {
      const verified = await verifiedTarget(parsed.firstMember);
      const result = await input.listsService.create({ ...parsed, firstMember: verified.target, ownerId });
      await persistThumbnail(verified, requestId);
      return result;
    }, (parsed) => ({ commandId: parsed.commandId, targetIds: parsed.firstMember.kind === "game" ? [parsed.firstMember.gameId] : [] })),
    add: (value: unknown) => boundary(value, add, async (parsed, ownerId, requestId) => {
      const verified = await verifiedTarget(parsed.member);
      const result = await input.listsService.add({ ...parsed, member: verified.target, ownerId });
      await persistThumbnail(verified, requestId);
      return result;
    }),
    archive: (value: unknown) => boundary(value, list, (parsed, ownerId) => input.listsService.archive({ ...parsed, ownerId })),
    restore: (value: unknown) => boundary(value, list, (parsed, ownerId) => input.listsService.restore({ ...parsed, ownerId })),
    removeMember: (value: unknown) => boundary(value, member, (parsed, ownerId) => input.listsService.removeMember({ ...parsed, ownerId })),
    restoreMember: (value: unknown) => boundary(value, member, (parsed, ownerId) => input.listsService.restoreMember({ ...parsed, ownerId })),
    describeMember: (value: unknown) => boundary(value, describe, (parsed, ownerId) => input.listsService.describeMember({ ...parsed, ownerId })),
    retryThumbnail: (value: unknown) => boundary(value, retryThumbnail, async (parsed) => {
      if (!input.externalThumbnailService) throw new Error("external thumbnail service unavailable");
      const confirmation = await input.gamesService.getExternalGameConfirmation({ ref: parsed.ref });
      if (!confirmation.snapshot.coverUrl) throw new ExternalReferenceThumbnailUnavailableError();
      await input.externalThumbnailService.ensure(parsed.ref, confirmation.snapshot.coverUrl);
      return {};
    }),
  };
}

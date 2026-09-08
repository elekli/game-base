import { z } from "zod";
import { assertReference, type ContributorMatch, type GamesService } from "@/modules/games";
import type { LibraryService } from "@/modules/library";
import { handlePrivateAction, type PrivateActionDependencies, type PrivateActionResult } from "@/shared/auth/private-action";
import type { OwnerIdentity } from "@/shared/auth/verify-access-token";

const addContributionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), gameId: z.uuid(), name: z.string().trim().min(1).max(200), entityKind: z.enum(["person", "company"]), role: z.enum(["design", "art", "publisher"]), allowDuplicate: z.boolean() }),
  z.object({ kind: z.literal("existing"), gameId: z.uuid(), contributorId: z.uuid(), role: z.enum(["design", "art", "publisher"]) }),
]);
type AddManualContributionSuccess = Readonly<
  | { status: "created" }
  | { status: "confirmation_required"; matches: readonly ContributorMatch[] }
>;
const removeContributionSchema = z.object({ gameId: z.uuid(), contributionId: z.uuid() });
const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const editGameSchema = z.object({ commandId: canonicalUuidSchema, expectedVersion: z.number().int().positive(), gameId: canonicalUuidSchema, displayName: z.string().trim().max(200).nullable().optional(), actualPlatforms: z.array(z.string().trim().max(100)).max(20).optional(), tags: z.array(z.string().trim().max(100)).max(50).optional(), playerCountNote: z.string().trim().max(500).nullable().optional() });
const linkExternalSourceSchema = z.object({ gameId: z.uuid(), provider: z.enum(["bgg", "igdb"]), sourceId: z.string(), confirmationFingerprint: z.string().min(1) });
const refreshExternalMetadataSchema = z.object({ gameId: z.uuid(), operationId: z.uuid() });
const sharedNameSchema = z.object({ name: z.string().trim().min(1).max(100) });

type AdapterDependencies = Readonly<{
  getHeaders: () => Promise<Headers>;
  getPrivateDependencies: () => PrivateActionDependencies;
  gamesService: Pick<GamesService, "linkExternalSource" | "refreshExternalMetadata">;
  libraryService: Pick<LibraryService, "addManualContribution" | "removeManualContribution" | "editGameCommand" | "deletePlatform" | "deleteTag">;
}>;

export type PrivateMutationAdapter = Readonly<{
  addManualContribution(input: unknown): Promise<PrivateActionResult<AddManualContributionSuccess>>;
  removeManualContribution(input: unknown): Promise<PrivateActionResult>;
  editGame(input: unknown): Promise<PrivateActionResult>;
  linkExternalSource(input: unknown): Promise<PrivateActionResult>;
  refreshExternalMetadata(input: unknown): Promise<PrivateActionResult>;
  deletePlatform(input: unknown): Promise<PrivateActionResult>;
  deleteTag(input: unknown): Promise<PrivateActionResult>;
}>;

export function createPrivateMutationAdapter({ getHeaders, getPrivateDependencies, gamesService, libraryService }: AdapterDependencies): PrivateMutationAdapter {
  function boundary<Input, Success extends object>(options: { input: unknown; schema: z.ZodType<Input>; inputErrorMessage: string; operation: (input: Input, owner: OwnerIdentity) => Promise<Success> }) {
    return getHeaders().then((headers) => handlePrivateAction(headers, {
      ...getPrivateDependencies(),
      input: options.input,
      schema: options.schema,
      inputErrorMessage: options.inputErrorMessage,
      operation: async (owner, parsed) => options.operation(parsed, owner),
    }));
  }

  return {
    addManualContribution(input) {
      return boundary({ input, schema: addContributionSchema, inputErrorMessage: "貢獻關係參數無效。", operation: async (parsed) => {
        const result = await libraryService.addManualContribution(parsed);
        return result.status === "created"
          ? { status: "created" }
          : { status: "confirmation_required", matches: result.matches };
      } });
    },
    removeManualContribution(input) {
      return boundary({ input, schema: removeContributionSchema, inputErrorMessage: "貢獻關係參數無效。", operation: async ({ gameId, contributionId }) => {
        await libraryService.removeManualContribution(gameId, contributionId);
        return {};
      } });
    },
    editGame(input) {
      return boundary({ input, schema: editGameSchema, inputErrorMessage: "遊戲資料參數無效。", operation: async ({ commandId, expectedVersion, gameId, ...payload }, owner) => {
        await libraryService.editGameCommand({ ownerId: owner.sub, commandId, expectedVersion, gameId, payload });
        return {};
      } });
    },
    linkExternalSource(input) {
      return boundary({ input, schema: linkExternalSourceSchema, inputErrorMessage: "來源連結參數無效。", operation: async ({ gameId, provider, sourceId, confirmationFingerprint }) => {
        const ref = provider === "bgg" ? assertReference({ provider: "bgg", medium: "board_game", sourceId }) : assertReference({ provider: "igdb", medium: "video_game", sourceId });
        await gamesService.linkExternalSource({ gameId, ref, confirmationFingerprint });
        return {};
      } });
    },
    refreshExternalMetadata(input) {
      return boundary({ input, schema: refreshExternalMetadataSchema, inputErrorMessage: "重新整理參數無效。", operation: async (parsed) => {
        await gamesService.refreshExternalMetadata(parsed);
        return {};
      } });
    },
    deletePlatform(input) {
      return boundary({ input, schema: sharedNameSchema, inputErrorMessage: "平台參數無效。", operation: async ({ name }) => {
        await libraryService.deletePlatform(name);
        return {};
      } });
    },
    deleteTag(input) {
      return boundary({ input, schema: sharedNameSchema, inputErrorMessage: "標籤參數無效。", operation: async ({ name }) => {
        await libraryService.deleteTag(name);
        return {};
      } });
    },
  };
}

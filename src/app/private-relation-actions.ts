"use server";

import "server-only";
import { headers } from "next/headers";
import { getPrivateDependencies } from "@/app/api/private/games/_private";
import { gamesService } from "@/app/games/service";
import { relationsService } from "@/app/relations/service";
import { externalThumbnailService } from "@/app/lists/external-thumbnail-service";
import { createPrivateRelationAdapter } from "@/app/private-relation-adapter";

const adapter = createPrivateRelationAdapter({
  getHeaders: async () => new Headers(await headers()), getPrivateDependencies, relationsService, gamesService, externalThumbnailService,
  onExternalThumbnailFailure: (requestId) => getPrivateDependencies().onUnhandledFailure({ errorCode: "external_reference_thumbnail_unavailable", requestId }),
});
export async function searchRelationTargets(input: unknown) { return adapter.search(input); }
export async function addGameRelation(input: unknown) { return adapter.add(input); }
export async function removeGameRelation(input: unknown) { return adapter.remove(input); }
export async function restoreGameRelation(input: unknown) { return adapter.restore(input); }
export async function describeGameRelation(input: unknown) { return adapter.describe(input); }

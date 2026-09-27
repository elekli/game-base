"use server";

import "server-only";
import { headers } from "next/headers";
import { getPrivateDependencies } from "@/app/api/private/games/_private";
import { listsService } from "@/app/lists/service";
import { gamesService } from "@/app/games/service";
import { createPrivateListAdapter } from "@/app/private-list-adapter";
import { externalThumbnailService } from "@/app/lists/external-thumbnail-service";

const adapter = createPrivateListAdapter({
  getHeaders: async () => new Headers(await headers()), getPrivateDependencies, listsService, gamesService,
  externalThumbnailService,
  onExternalThumbnailFailure: (requestId) => getPrivateDependencies().onUnhandledFailure({ errorCode: "external_reference_thumbnail_unavailable", requestId }),
});
export async function createList(input: unknown) { return adapter.create(input); }
export async function addListMember(input: unknown) { return adapter.add(input); }
export async function archiveList(input: unknown) { return adapter.archive(input); }
export async function restoreList(input: unknown) { return adapter.restore(input); }
export async function removeListMember(input: unknown) { return adapter.removeMember(input); }
export async function restoreListMember(input: unknown) { return adapter.restoreMember(input); }
export async function describeListMember(input: unknown) { return adapter.describeMember(input); }
export async function retryExternalListThumbnail(input: unknown) { return adapter.retryThumbnail(input); }

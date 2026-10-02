"use server";

import "server-only";
import { headers } from "next/headers";
import { getPrivateDependencies } from "@/app/api/private/games/_private";
import { createPrivateMutationAdapter } from "@/app/private-mutation-adapter";

const privateMutationAdapter = createPrivateMutationAdapter({
  getHeaders: async () => new Headers(await headers()),
  getPrivateDependencies,
  getServices: async () => import("@/app/games/service"),
});

export async function addManualContribution(input: unknown) {
  return privateMutationAdapter.addManualContribution(input);
}

export async function removeManualContribution(input: unknown) {
  return privateMutationAdapter.removeManualContribution(input);
}

export async function editGame(input: unknown) {
  return privateMutationAdapter.editGame(input);
}

export async function moveGameToTrash(input: unknown) {
  return privateMutationAdapter.moveGameToTrash(input);
}

export async function restoreGame(input: unknown) {
  return privateMutationAdapter.restoreGame(input);
}

export async function linkExternalSource(input: unknown) {
  return privateMutationAdapter.linkExternalSource(input);
}

export async function refreshExternalMetadata(input: unknown) {
  return privateMutationAdapter.refreshExternalMetadata(input);
}

export async function deletePlatform(input: unknown) {
  return privateMutationAdapter.deletePlatform(input);
}

export async function deleteTag(input: unknown) {
  return privateMutationAdapter.deleteTag(input);
}

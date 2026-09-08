"use server";

import "server-only";
import { headers } from "next/headers";
import { getPrivateDependencies } from "@/app/api/private/games/_private";
import { notesService } from "@/app/notes/service";
import { createPrivateNoteAdapter } from "@/app/private-note-adapter";

const adapter = createPrivateNoteAdapter({ getHeaders: async () => new Headers(await headers()), getPrivateDependencies, notesService });
export async function createNote(input: unknown) { return adapter.create(input); }
export async function updateNote(input: unknown) { return adapter.update(input); }
export async function removeNote(input: unknown) { return adapter.remove(input); }
export async function restoreNote(input: unknown) { return adapter.restore(input); }

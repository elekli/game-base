import "server-only";

import { createDatabase } from "@/adapters/database";
import { PostgresNoteStore } from "@/adapters/postgres-note-store";
import { InMemoryNoteStore, createNotesService } from "@/modules/notes";

const useFixtures = process.env.ALLOW_SOURCE_FIXTURES === "true";
const database = !useFixtures && process.env.DATABASE_URL?.startsWith("postgres") ? createDatabase(process.env.DATABASE_URL) : null;
const globalStore = globalThis as typeof globalThis & { __puizeruNoteStore?: InMemoryNoteStore };
const store = database ? new PostgresNoteStore(database.db) : useFixtures ? (globalStore.__puizeruNoteStore ??= new InMemoryNoteStore()) : null;

const unavailable = new Proxy({}, { get: () => async () => { throw new Error("notes unavailable"); } }) as InMemoryNoteStore;
export const notesService = createNotesService(store ?? unavailable);

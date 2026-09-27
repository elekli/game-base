import "server-only";
import { createDatabase } from "@/adapters/database";
import { PostgresListStore } from "@/adapters/postgres-list-store";
import { createListsService, InMemoryListStore } from "@/modules/lists";
import { externalThumbnailService } from "./external-thumbnail-service";

const useFixtures = process.env.ALLOW_SOURCE_FIXTURES === "true";
const database = !useFixtures && process.env.DATABASE_URL?.startsWith("postgres") ? createDatabase(process.env.DATABASE_URL) : null;
const globalStore = globalThis as typeof globalThis & { __puizeruListStore?: InMemoryListStore };
const issueThumbnailRead = externalThumbnailService ? externalThumbnailService.issueRead : undefined;
const store = database ? new PostgresListStore(database.db, issueThumbnailRead) : useFixtures ? (globalStore.__puizeruListStore ??= new InMemoryListStore()) : null;
const unavailable = new Proxy({}, { get: () => async () => { throw new Error("lists unavailable"); } }) as PostgresListStore;
export const listsService = createListsService(store ?? unavailable);

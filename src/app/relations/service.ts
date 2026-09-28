import "server-only";
import { createDatabase } from "@/adapters/database";
import { PostgresRelationStore } from "@/adapters/postgres-relation-store";
import { createRelationsService, InMemoryRelationStore } from "@/modules/relations";
import { externalThumbnailService } from "@/app/lists/external-thumbnail-service";

const useFixtures = process.env.ALLOW_SOURCE_FIXTURES === "true";
const database = !useFixtures && process.env.DATABASE_URL?.startsWith("postgres") ? createDatabase(process.env.DATABASE_URL) : null;
const globalStore = globalThis as typeof globalThis & { __puizeruRelationStore?: InMemoryRelationStore };
const store = database ? new PostgresRelationStore(database.db, externalThumbnailService?.issueRead) : useFixtures ? (globalStore.__puizeruRelationStore ??= new InMemoryRelationStore()) : null;
const unavailable = new Proxy({}, { get: () => async () => { throw new Error("relations unavailable"); } }) as PostgresRelationStore;
export const relationsService = createRelationsService(store ?? unavailable);

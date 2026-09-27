import "server-only";
import { createDatabase } from "@/adapters/database";
import { ExternalThumbnailObjectStore } from "@/adapters/external-thumbnail-object-store";
import { PostgresExternalThumbnailStore } from "@/adapters/postgres-external-thumbnail-store";
import { createExternalReferenceThumbnailService } from "@/modules/lists/external-reference-thumbnail";
import { getRuntimeConfig } from "@/shared/config/get-runtime-config";

const useFixtures = process.env.ALLOW_SOURCE_FIXTURES === "true";

export const externalThumbnailService = useFixtures ? null : (() => {
  const config = getRuntimeConfig();
  const database = createDatabase(config.databaseUrl);
  return createExternalReferenceThumbnailService({
    store: new PostgresExternalThumbnailStore(database.db),
    objects: new ExternalThumbnailObjectStore({ supabaseUrl: config.supabase.url, secretKey: config.supabase.secretKey }),
  });
})();

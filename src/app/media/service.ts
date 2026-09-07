import "server-only";
import { createDatabase } from "@/adapters/database";
import { PostgresMediaStore } from "@/adapters/postgres-media-store";
import { SupabaseMediaObjectStore } from "@/adapters/supabase-media-object-store";
import { getRuntimeConfig } from "@/shared/config/get-runtime-config";
import { createMediaService } from "@/modules/media/internal/create-media-service";

const config = getRuntimeConfig();
const database = createDatabase(config.databaseUrl);

export const mediaService = createMediaService({
  store: new PostgresMediaStore(database.db),
  objects: new SupabaseMediaObjectStore({ supabaseUrl: config.supabase.url, secretKey: config.supabase.secretKey, bucket: "game-media" }),
  readCapacitySnapshot: async () => config.mediaStorageCapacity,
});

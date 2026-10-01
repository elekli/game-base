import { sql, type SQL } from "drizzle-orm";

export function referenceKey(externalIdentityId: SQL, gameIdentityId: SQL, gameId: SQL): SQL {
  return sql`case when ${externalIdentityId} is not null then '0:' || ${externalIdentityId}::text else coalesce('0:' || ${gameIdentityId}::text, '1:' || ${gameId}::text) end`;
}

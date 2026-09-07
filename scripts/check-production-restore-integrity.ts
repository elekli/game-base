import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

export class ProductionRestoreIntegrityError extends Error {
  constructor(readonly safeDetail: string) {
    super(`ProductionRestoreIntegrityError: ${safeDetail}`);
    this.name = "ProductionRestoreIntegrityError";
  }
}

type Query = (text: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

export type AppPrivateDataManifest = ReadonlyArray<Readonly<{
  tableName: string;
  rowCount: string;
  digestA: string;
  digestB: string;
}>>;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function collectAppPrivateDataManifest(query: Query): Promise<AppPrivateDataManifest> {
  const tables = await query(`
    select c.relname as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relkind in ('r', 'p') and not c.relispartition
    order by c.relname
  `);
  const manifest: Array<AppPrivateDataManifest[number]> = [];
  for (const row of tables) {
    if (typeof row.table_name !== "string" || row.table_name === "") {
      throw new ProductionRestoreIntegrityError("application data manifest catalog is invalid");
    }
    const result = await query(`
      select count(*)::text as row_count,
             coalesce(sum((('x' || substr(md5(to_jsonb(record)::text), 1, 16))::bit(64)::bigint)::numeric), 0)::text as digest_a,
             coalesce(sum((('x' || substr(md5(to_jsonb(record)::text), 17, 16))::bit(64)::bigint)::numeric), 0)::text as digest_b
      from app_private.${quoteIdentifier(row.table_name)} record
    `);
    const summary = result[0];
    if (
      typeof summary?.row_count !== "string" ||
      typeof summary.digest_a !== "string" ||
      typeof summary.digest_b !== "string"
    ) {
      throw new ProductionRestoreIntegrityError("application data manifest result is invalid");
    }
    manifest.push({
      tableName: row.table_name,
      rowCount: summary.row_count,
      digestA: summary.digest_a,
      digestB: summary.digest_b,
    });
  }
  return manifest;
}

export async function checkProductionRestoreIntegrity({
  expectedMigrationVersions,
  query,
}: Readonly<{
  expectedMigrationVersions: ReadonlyArray<string>;
  query: Query;
}>): Promise<number> {
  if (expectedMigrationVersions.length < 1) {
    throw new ProductionRestoreIntegrityError("migration manifest is empty");
  }
  const identity = await query(`
    select current_database() as database,
           to_regnamespace('app_private') is not null as schema_exists
  `);
  if (identity[0]?.database !== "postgres" || identity[0]?.schema_exists !== true) {
    throw new ProductionRestoreIntegrityError("restore target identity is invalid");
  }

  const migrations = await query(`
    select version from supabase_migrations.schema_migrations order by version
  `);
  const actualVersions = migrations.map((row) => String(row.version));
  if (JSON.stringify(actualVersions) !== JSON.stringify(expectedMigrationVersions)) {
    throw new ProductionRestoreIntegrityError("restored migration ledger does not match the repository");
  }

  const tables = await query(`
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relkind in ('r', 'p')
    order by c.relname
  `);
  if (tables.length < 1 || tables.some((row) => row.rls_enabled !== true)) {
    throw new ProductionRestoreIntegrityError("restored application tables or RLS invariants are invalid");
  }

  const constraints = await query(`
    select count(*)::int as invalid_count
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_namespace n on n.oid = constraint_record.connamespace
    where n.nspname = 'app_private' and not constraint_record.convalidated
  `);
  if (constraints[0]?.invalid_count !== 0) {
    throw new ProductionRestoreIntegrityError("restored constraints are not fully validated");
  }

  for (const row of tables) {
    if (typeof row.table_name !== "string" || row.table_name === "") {
      throw new ProductionRestoreIntegrityError("restored table catalog is invalid");
    }
    await query(`select count(*)::bigint as row_count from app_private.${quoteIdentifier(row.table_name)}`);
  }
  return 4 + tables.length;
}

async function main() {
  const databaseUrl = process.env.DIRECT_DATABASE_URL;
  if (!databaseUrl) {
    throw new ProductionRestoreIntegrityError("local restore database URL is missing");
  }
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.port !== "55432" || url.pathname !== "/postgres") {
    throw new ProductionRestoreIntegrityError("integrity checker is not bound to the isolated local target");
  }
  const expectedMigrationVersions = (await readdir("supabase/migrations"))
    .map((name) => name.match(/^([0-9]+)_.*\.sql$/)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort();
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const checks = await checkProductionRestoreIntegrity({
      expectedMigrationVersions,
      query: async (text) => sql.unsafe(text),
    });
    console.log(JSON.stringify({ event: "production_restore_integrity_passed", checks }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safeDetail = error instanceof ProductionRestoreIntegrityError
      ? error.safeDetail
      : "isolated restore integrity verification failed";
    console.error(JSON.stringify({ event: "production_restore_integrity_failed", safeDetail }));
    process.exitCode = 1;
  });
}

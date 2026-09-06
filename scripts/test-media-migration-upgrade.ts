import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const databaseUrl = process.env.DIRECT_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const fixture = readFileSync("scripts/fixtures/0006_ready_media.sql", "utf8");

function supabase(...args: string[]): void {
  execFileSync("supabase", args, { stdio: "inherit" });
}

try {
  supabase("db", "reset", "--version", "0006", "--no-seed");
  const before = postgres(databaseUrl, { max: 1, prepare: false });
  await before.unsafe("grant app_runtime to postgres");
  await before.unsafe("set role app_runtime");
  await before.unsafe(fixture);
  await before.unsafe("reset role");
  await before.end();

  supabase("migration", "up", "--local");
  const after = postgres(databaseUrl, { max: 1, prepare: false });
  const rows = await after.unsafe<Readonly<Record<string, unknown>>[]>(`
    select ingest.id, ingest.state, ingest.external_game_identity_id,
      exists(select 1 from app_private.media_assets asset where asset.ingest_id = ingest.id) as has_asset
    from app_private.media_ingests ingest
    where ingest.id in (
      '63000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000002'
    )
    order by ingest.id
  `);
  const [{ derivative_count, source_pointer_count }] = await after.unsafe<Readonly<Record<string, unknown>>[]>(`
    select
      (select count(*)::int from app_private.media_derivatives) as derivative_count,
      (select count(*)::int from app_private.external_game_identities where source_cover_asset_id is not null) as source_pointer_count
  `);
  await after.end();
  if (rows.length !== 2 || rows.some((row) => row.state !== "cleanup_pending" || row.has_asset !== false ||
      row.external_game_identity_id !== "61000000-0000-4000-8000-000000000001") ||
      Number(derivative_count) !== 0 || Number(source_pointer_count) !== 0) {
    throw new Error("0007 did not fail closed for unverifiable legacy media");
  }
  console.log(JSON.stringify({ event: "media_migration_upgrade_passed", from: "0006", to: "0007" }));
} finally {
  supabase("db", "reset");
}

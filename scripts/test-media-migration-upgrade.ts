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
    select ingest.state as ingest_state, ingest.reserved_asset_id,
      ingest.external_game_identity_id, ingest.actual_mime_type, ingest.actual_byte_size,
      asset.id as asset_id, asset.verification_state, asset.width, asset.height,
      derivative.state as derivative_state, derivative.current_object_path,
      derivative.object_key as legacy_derivative_path
    from app_private.media_ingests ingest
    join app_private.media_assets asset on asset.ingest_id = ingest.id
    join app_private.media_derivatives derivative on derivative.asset_id = asset.id
    where ingest.id = '63000000-0000-4000-8000-000000000001'
  `);
  await after.end();
  const row = rows[0];
  if (!row || row.ingest_state !== "finalized" || row.reserved_asset_id !== row.asset_id ||
      row.external_game_identity_id !== "61000000-0000-4000-8000-000000000001" ||
      row.actual_mime_type !== "image/jpeg" || Number(row.actual_byte_size) !== 123 ||
      row.verification_state !== "pending_revalidation" || row.width !== null || row.height !== null ||
      row.derivative_state !== "pending" || row.current_object_path !== null ||
      row.legacy_derivative_path !== "games/62000000-0000-4000-8000-000000000001/source/legacy.webp") {
    throw new Error("0007 did not preserve and explicitly reclassify legacy ready media");
  }
  console.log(JSON.stringify({ event: "media_migration_upgrade_passed", from: "0006", to: "0007" }));
} finally {
  supabase("db", "reset");
}

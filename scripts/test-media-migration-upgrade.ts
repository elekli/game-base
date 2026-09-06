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
  await after.unsafe("set role app_runtime");
  await after.unsafe(`
    insert into app_private.media_ingests (id, game_id, source_url, object_key, original_state, thumbnail_state)
    values ('63000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000001',
      'https://cf.geekdo-images.com/post-expand.jpg', 'games/62000000-0000-4000-8000-000000000001/source/post-expand.bin', 'ready', 'ready');
    insert into app_private.media_assets (id, ingest_id, kind, object_key, mime_type, byte_size)
    values ('64000000-0000-4000-8000-000000000003', '63000000-0000-4000-8000-000000000003', 'source_cover',
      'games/62000000-0000-4000-8000-000000000001/source/post-expand.bin', 'image/jpeg', 321);
    insert into app_private.media_derivatives (asset_id, kind, object_key, state)
    values ('64000000-0000-4000-8000-000000000003', 'thumbnail_webp',
      'games/62000000-0000-4000-8000-000000000001/source/post-expand.webp', 'ready');
  `);
  const rows = await after.unsafe<Readonly<Record<string, unknown>>[]>(`
    select ingest.id, asset.byte_size, asset.authority_state, asset.object_key,
      derivative.object_key as derivative_object_key, derivative.authority_state as derivative_authority_state
    from app_private.media_ingests ingest
    join app_private.media_assets asset on asset.ingest_id = ingest.id
    join app_private.media_derivatives derivative on derivative.asset_id = asset.id
    where ingest.id in ('63000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '63000000-0000-4000-8000-000000000003')
    order by ingest.id
  `);
  const [{ authoritative_count, source_pointer_count }] = await after.unsafe<Readonly<Record<string, unknown>>[]>(`
    select
      (select count(*)::int from app_private.media_assets where authority_state = 'verified') as authoritative_count,
      (select count(*)::int from app_private.external_game_identities where source_cover_asset_id is not null) as source_pointer_count
  `);
  await after.unsafe("reset role");
  await after.end();
  if (rows.length !== 3 || rows.some((row) => row.authority_state !== "legacy_unverified" || row.derivative_authority_state !== "legacy_unverified" ||
      !String(row.object_key).includes("games/") || !String(row.derivative_object_key).includes("games/")) ||
      Number(rows[1].byte_size) !== 0 || Number(authoritative_count) !== 0 || Number(source_pointer_count) !== 0) {
    throw new Error("0007 expand did not preserve legacy writes while excluding them from authoritative reads");
  }
  console.log(JSON.stringify({ event: "media_migration_upgrade_passed", from: "0006", to: "0007" }));
} finally {
  supabase("db", "reset");
}

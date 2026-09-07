insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot)
values ('61000000-0000-4000-8000-000000000001', 'bgg', '620001', 'board_game', '{}'::jsonb);

insert into app_private.games (id, medium, display_name, external_game_identity_id)
values ('62000000-0000-4000-8000-000000000001', 'board_game', '舊版 ready 媒體', '61000000-0000-4000-8000-000000000001');

insert into app_private.media_ingests (
  id, game_id, source_url, object_key, original_state, thumbnail_state
) values (
  '63000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001',
  'https://cf.geekdo-images.com/legacy.jpg',
  'games/62000000-0000-4000-8000-000000000001/source/legacy.bin',
  'ready', 'ready'
);

insert into app_private.media_assets (
  id, ingest_id, kind, object_key, mime_type, byte_size
) values (
  '64000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  'source_cover',
  'games/62000000-0000-4000-8000-000000000001/source/legacy.bin',
  'image/jpeg', 123
);

insert into app_private.media_derivatives (asset_id, kind, object_key, state)
values (
  '64000000-0000-4000-8000-000000000001',
  'thumbnail_webp',
  'games/62000000-0000-4000-8000-000000000001/source/legacy.webp',
  'ready'
);

insert into app_private.media_ingests (
  id, game_id, source_url, object_key, original_state, thumbnail_state
) values (
  '63000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000001',
  'https://cf.geekdo-images.com/legacy-zero.jpg',
  'games/62000000-0000-4000-8000-000000000001/source/legacy-zero.bin',
  'ready', 'ready'
);

insert into app_private.media_assets (
  id, ingest_id, kind, object_key, mime_type, byte_size
) values (
  '64000000-0000-4000-8000-000000000002',
  '63000000-0000-4000-8000-000000000002',
  'source_cover',
  'games/62000000-0000-4000-8000-000000000001/source/legacy-zero.bin',
  'image/jpeg', 0
);

insert into app_private.media_derivatives (asset_id, kind, object_key, state)
values (
  '64000000-0000-4000-8000-000000000002',
  'thumbnail_webp',
  'games/62000000-0000-4000-8000-000000000001/source/legacy-zero.webp',
  'ready'
);

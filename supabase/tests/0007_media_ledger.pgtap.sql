begin;
select plan(50);

select has_column('app_private', 'media_ingests', 'idempotency_key', 'ingest 保存全域冪等鍵');
select has_column('app_private', 'media_ingests', 'reserved_asset_id', 'ingest 預留固定 asset id');
select has_column('app_private', 'media_assets', 'removed_at', 'asset 具備軟移除欄位');
select has_column('app_private', 'games', 'manual_cover_asset_id', '遊戲具備人工封面指標');
select has_table('app_private', 'media_derivative_attempts', '衍生物 attempt 狀態帳存在');
select ok(to_regclass('app_private.media_ingests_idempotency_key_key') is not null, '冪等鍵由唯一約束守住');
select ok((
  select opc.opcname = 'text_ops'
  from pg_index idx join pg_class rel on rel.oid = idx.indexrelid
  join pg_opclass opc on opc.oid = idx.indclass[0]
  where rel.relname = 'media_ingests_finalize_candidates_idx'
), 'finalize 索引 state 使用 text_ops');
select ok((
  select opc.opcname = 'timestamptz_ops'
  from pg_index idx join pg_class rel on rel.oid = idx.indexrelid
  join pg_opclass opc on opc.oid = idx.indclass[1]
  where rel.relname = 'media_ingests_finalize_candidates_idx'
), 'finalize 索引 lease_until 使用 timestamptz_ops');
select ok(not has_function_privilege('public', 'app_private.prevent_system_platform_mutation()', 'execute'), 'system platform trigger function 不授予 PUBLIC EXECUTE');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;

insert into app_private.games (id, medium, display_name)
values
  ('10000000-0000-4000-8000-000000000001', 'board_game', '媒體資料庫測試一'),
  ('10000000-0000-4000-8000-000000000002', 'board_game', '媒體資料庫測試二');

insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot)
values ('11000000-0000-4000-8000-000000000001', 'bgg', '620007', 'board_game', '{}'::jsonb);

select extensions.throws_like(
  $$insert into app_private.media_ingests (idempotency_key, reserved_asset_id, channel, purpose, game_id, original_object_path, original_file_name, declared_mime_type, state, stale_after, source_url, object_key, original_state, thumbnail_state) values (gen_random_uuid()::text, gen_random_uuid(), 'source_fetch', 'source_cover', '10000000-0000-4000-8000-000000000001', 'originals/source/no-identity', 'source-cover', 'application/octet-stream', 'issued', now() + interval '26 hours', 'https://example.test/a', 'originals/source/no-identity', 'pending', 'pending')$$,
  '%violates check constraint%',
  'source cover ingest 必須帶 external identity'
);

select extensions.throws_like(
  $$insert into app_private.media_ingests (idempotency_key, reserved_asset_id, channel, purpose, game_id, external_game_identity_id, original_object_path, original_file_name, declared_mime_type, declared_byte_size, state, stale_after, source_url, object_key, original_state, thumbnail_state) values (gen_random_uuid()::text, gen_random_uuid(), 'browser_tus', 'gallery_image', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'originals/browser/with-identity', 'photo.png', 'image/png', 24, 'issued', now() + interval '26 hours', '', 'originals/browser/with-identity', 'pending', 'pending')$$,
  '%violates check constraint%',
  'browser ingest 不可帶 external identity'
);

insert into app_private.media_ingests (
  id, idempotency_key, reserved_asset_id, channel, purpose, game_id,
  original_object_path, original_file_name, declared_mime_type, declared_byte_size,
  state, stale_after, source_url, object_key, original_state, thumbnail_state
) values (
  '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', 'browser_tus', 'gallery_image',
  '10000000-0000-4000-8000-000000000001', 'originals/40000000-0000-4000-8000-000000000001/a',
  'photo.png', 'image/png', 24, 'issued', now() + interval '26 hours',
  '', 'originals/40000000-0000-4000-8000-000000000001/a', 'pending', 'pending'
);

select extensions.throws_like(
  $$insert into app_private.media_ingests (idempotency_key, reserved_asset_id, channel, purpose, game_id, original_object_path, original_file_name, declared_mime_type, declared_byte_size, state, stale_after, source_url, object_key, original_state, thumbnail_state) values ('30000000-0000-4000-8000-000000000001', gen_random_uuid(), 'browser_tus', 'gallery_image', '10000000-0000-4000-8000-000000000001', 'originals/duplicate/path', 'other.png', 'image/png', 24, 'issued', now() + interval '26 hours', '', 'originals/duplicate/path', 'pending', 'pending')$$,
  '%duplicate key value violates unique constraint%',
  '同一冪等鍵不可建立第二筆 ingest'
);

select extensions.throws_like(
  $$insert into app_private.media_ingests (idempotency_key, reserved_asset_id, channel, purpose, game_id, original_object_path, original_file_name, declared_mime_type, declared_byte_size, state, stale_after, source_url, object_key, original_state, thumbnail_state) values (gen_random_uuid()::text, gen_random_uuid(), 'browser_tus', 'gallery_image', '10000000-0000-4000-8000-000000000001', 'originals/oversize/path', 'large.png', 'image/png', 52428801, 'issued', now() + interval '26 hours', '', 'originals/oversize/path', 'pending', 'pending')$$,
  '%violates check constraint%',
  '資料庫拒絕超過 50 MiB 的宣稱大小'
);

update app_private.media_ingests
set actual_mime_type = 'image/png', actual_byte_size = 24, image_width = 2, image_height = 3,
    state = 'finalizing', lease_token = '50000000-0000-4000-8000-000000000001', lease_until = now() + interval '5 minutes'
where id = '20000000-0000-4000-8000-000000000001';

select extensions.throws_like(
  $$update app_private.media_ingests set state = 'finalized', lease_token = null, lease_until = null, finalized_at = now() where id = '20000000-0000-4000-8000-000000000001'$$,
  '%finalized media ingest must match a verified asset%',
  '沒有 verified asset 的 ingest 不可直接進入 finalized'
);

select extensions.throws_like(
  $$insert into app_private.media_assets (id, ingest_id, game_id, purpose, original_object_path, original_file_name, actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type) values ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'gallery_image', 'originals/40000000-0000-4000-8000-000000000001/a', 'photo.png', 'image/png', 24, 2, 3, 'verified', 'gallery_image', 'originals/40000000-0000-4000-8000-000000000001/a', 'image/png')$$,
  '%media asset must match its finalized ingest ledger%',
  'finalizing ingest 不可單獨提交 verified asset'
);
select extensions.throws_like(
  $$insert into app_private.media_assets (id, ingest_id, game_id, purpose, original_object_path, original_file_name, actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type) values ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'gallery_image', 'originals/40000000-0000-4000-8000-000000000001/a', 'photo.png', 'image/png', 24, 2, 3, 'verified', 'source_cover', 'originals/contradictory', 'image/jpeg')$$,
  '%verified media asset aliases must match authority fields%',
  'verified asset 不可提交矛盾的 legacy alias 欄位'
);

set constraints app_private.media_assets_valid_references deferred;

insert into app_private.media_assets (
  id, ingest_id, game_id, purpose, original_object_path, original_file_name,
  actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type
) values (
  '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001', 'gallery_image',
  'originals/40000000-0000-4000-8000-000000000001/a', 'photo.png', 'image/png', 24, 2, 3, 'verified',
  'gallery_image', 'originals/40000000-0000-4000-8000-000000000001/a', 'image/png'
);

select extensions.throws_like(
  $$update app_private.media_assets set byte_size = 0 where id = '40000000-0000-4000-8000-000000000001'$$,
  '%violates check constraint%',
  '權威 asset 不可為零 byte'
);

insert into app_private.media_derivatives (asset_id, spec, authority_state, state, kind)
values ('40000000-0000-4000-8000-000000000001', 'thumb_webp_v1', 'verified', 'pending', 'thumbnail_webp');
select ok(exists(select 1 from app_private.media_derivatives where asset_id = '40000000-0000-4000-8000-000000000001' and state = 'pending' and current_object_path is null), '圖片可建立尚無指標的 pending derivative');
select extensions.throws_like(
  $$delete from app_private.media_derivatives where asset_id = '40000000-0000-4000-8000-000000000001'$$,
  '%cannot delete verified image derivative%',
  'verified image asset 的固定 derivative 不可刪除'
);

update app_private.media_ingests set state = 'finalized', lease_token = null, lease_until = null, finalized_at = now()
where id = '20000000-0000-4000-8000-000000000001';
set constraints app_private.media_assets_valid_references immediate;
select extensions.throws_like(
  $$update app_private.media_ingests set state = 'issued' where id = '20000000-0000-4000-8000-000000000001'$$,
  '%finalized media ingest authority fields are immutable%',
  '已有權威 asset 的 ingest 不可退回 issued'
);
select extensions.throws_like(
  $$update app_private.media_ingests set reserved_asset_id = gen_random_uuid() where id = '20000000-0000-4000-8000-000000000001'$$,
  '%finalized media ingest authority fields are immutable%',
  '已有權威 asset 的 ingest 不可改寫 immutable authority 欄位'
);
select extensions.throws_like(
  $$delete from app_private.media_assets where id = '40000000-0000-4000-8000-000000000001'$$,
  '%cannot delete verified asset referenced by finalized ingest%',
  'finalized ingest 對應的 verified asset 不可刪除'
);
select extensions.throws_like(
  $$update app_private.media_assets set authority_state = 'legacy_unverified' where id = '40000000-0000-4000-8000-000000000001'$$,
  '%cannot detach verified asset referenced by finalized ingest%',
  '不可先降級 finalized verified asset 再繞過 DELETE guard'
);

select extensions.throws_like(
  $sql$do $attack$
  begin
    set constraints all deferred;
    update app_private.media_ingests set actual_mime_type = 'image/jpeg' where id = '20000000-0000-4000-8000-000000000001';
    update app_private.media_assets set actual_mime_type = 'image/jpeg' where id = '40000000-0000-4000-8000-000000000001';
    set constraints all immediate;
  end
  $attack$$sql$,
  '%finalized media ingest authority fields are immutable%',
  '即使延後所有 constraint 並同步修改 asset，finalized ingest 權威欄位仍不可變'
);
set constraints all deferred;
update app_private.media_ingests set actual_mime_type = 'image/png' where id = '20000000-0000-4000-8000-000000000001';
update app_private.media_assets set actual_mime_type = 'image/png' where id = '40000000-0000-4000-8000-000000000001';
set constraints all immediate;

select extensions.throws_like(
  $sql$do $attack$
  begin
    set constraints all deferred;
    update app_private.media_assets set original_file_name = 'rewritten.png' where id = '40000000-0000-4000-8000-000000000001';
    update app_private.media_ingests set original_file_name = 'rewritten.png' where id = '20000000-0000-4000-8000-000000000001';
    set constraints all immediate;
  end
  $attack$$sql$,
  '%finalized media asset authority fields are immutable%',
  '即使延後所有 constraint 並同步修改 ingest，verified asset 權威欄位仍不可變'
);
set constraints all deferred;
update app_private.media_assets set original_file_name = 'photo.png' where id = '40000000-0000-4000-8000-000000000001';
update app_private.media_ingests set original_file_name = 'photo.png' where id = '20000000-0000-4000-8000-000000000001';
set constraints all immediate;

select extensions.throws_like(
  $$update app_private.media_derivatives set state = 'ready' where asset_id = '40000000-0000-4000-8000-000000000001'$$,
  '%violates check constraint%',
  'ready derivative 必須具有完整現行物件資訊'
);

update app_private.games set manual_cover_asset_id = '40000000-0000-4000-8000-000000000001'
where id = '10000000-0000-4000-8000-000000000001';
select ok((select manual_cover_asset_id from app_private.games where id = '10000000-0000-4000-8000-000000000001') = '40000000-0000-4000-8000-000000000001', '同遊戲有效圖片可成為人工封面');

select extensions.throws_like(
  $$update app_private.games set manual_cover_asset_id = '40000000-0000-4000-8000-000000000001' where id = '10000000-0000-4000-8000-000000000002'$$,
  '%media manual cover must reference an active image from the same game%',
  '人工封面不可跨遊戲引用'
);

select extensions.throws_like(
  $$update app_private.media_assets set superseded_at = now() where id = '40000000-0000-4000-8000-000000000001'$$,
  '%only source cover may be superseded%',
  'gallery、custom cover 與 attachment 不可使用來源封面的 superseded 生命週期'
);
update app_private.media_assets set superseded_at = null where id = '40000000-0000-4000-8000-000000000001';

select extensions.throws_like(
  $$update app_private.media_assets set removed_at = now(), removed_reason = 'owner_removed' where id = '40000000-0000-4000-8000-000000000001'$$,
  '%media manual cover must reference an active image from the same game%',
  '仍被指向的人工封面不可單獨標成移除'
);

update app_private.games set manual_cover_asset_id = null where id = '10000000-0000-4000-8000-000000000001';
update app_private.media_assets set removed_at = now(), removed_reason = 'owner_removed' where id = '40000000-0000-4000-8000-000000000001';
select ok((select removed_at is not null from app_private.media_assets where id = '40000000-0000-4000-8000-000000000001'), '清除封面指標後可軟移除並保留 asset');

select ok((select count(*) from app_private.media_assets where id = '40000000-0000-4000-8000-000000000001') = 1, '軟移除不刪除權威原檔列');
select ok((select count(*) from app_private.media_derivatives where asset_id = '40000000-0000-4000-8000-000000000001') = 1, '軟移除不刪除 derivative 列');

update app_private.games
set external_game_identity_id = '11000000-0000-4000-8000-000000000001'
where id = '10000000-0000-4000-8000-000000000001';

insert into app_private.source_refresh_operations (operation_id, game_id, external_game_identity_id, payload_fingerprint)
values ('61000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', repeat('a', 64));
select extensions.throws_like(
  $$update app_private.source_refresh_operations set payload_fingerprint = repeat('b', 64) where operation_id = '61000000-0000-4000-8000-000000000001'$$,
  '%permission denied%',
  'app_runtime 不可改寫來源更新 receipt fingerprint'
);
select extensions.throws_like(
  $$delete from app_private.source_refresh_operations where operation_id = '61000000-0000-4000-8000-000000000001'$$,
  '%permission denied%',
  'app_runtime 不可刪除來源更新 receipt'
);
select is((select payload_fingerprint from app_private.source_refresh_operations where operation_id = '61000000-0000-4000-8000-000000000001'), repeat('a', 64), '相同 operation 永久保留原 payload fingerprint');

insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot)
values ('11000000-0000-4000-8000-000000000002', 'bgg', '620008', 'board_game', '{}'::jsonb);
select extensions.throws_like(
  $$insert into app_private.media_ingests (idempotency_key, reserved_asset_id, channel, purpose, game_id, external_game_identity_id, original_object_path, original_file_name, declared_mime_type, declared_byte_size, state, stale_after, source_url, object_key, original_state, thumbnail_state) values (gen_random_uuid()::text, gen_random_uuid(), 'source_fetch', 'source_cover', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'originals/source/wrong-identity', 'wrong.png', 'image/png', 24, 'issued', now() + interval '26 hours', 'https://example.test/wrong', 'originals/source/wrong-identity', 'pending', 'pending')$$,
  '%source cover ingest must match its game external identity%',
  'source cover ingest 不可使用另一個 external identity'
);

insert into app_private.media_ingests (
  id, idempotency_key, reserved_asset_id, channel, purpose, game_id, external_game_identity_id,
  original_object_path, original_file_name, declared_mime_type, declared_byte_size,
  actual_mime_type, actual_byte_size, image_width, image_height, state, lease_token, lease_until,
  stale_after, source_url, object_key, original_state, thumbnail_state
) values
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   'source_fetch', 'source_cover', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
   'originals/source/old', 'old.png', 'image/png', 24, 'image/png', 24, 2, 3, 'finalizing',
   '51000000-0000-4000-8000-000000000001', now() + interval '5 minutes', now() + interval '26 hours',
   'https://example.test/old', 'originals/source/old', 'pending', 'pending'),
  ('21000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002',
   'source_fetch', 'source_cover', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
   'originals/source/new', 'new.png', 'image/png', 24, 'image/png', 24, 2, 3, 'finalizing',
   '51000000-0000-4000-8000-000000000002', now() + interval '5 minutes', now() + interval '26 hours',
   'https://example.test/new', 'originals/source/new', 'pending', 'pending');
set constraints app_private.media_assets_valid_references deferred;
insert into app_private.media_assets (
  id, ingest_id, game_id, purpose, original_object_path, original_file_name,
  actual_mime_type, byte_size, width, height, authority_state, kind, object_key, mime_type
) values
  ('41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'source_cover', 'originals/source/old', 'old.png', 'image/png', 24, 2, 3, 'verified', 'source_cover', 'originals/source/old', 'image/png'),
  ('41000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'source_cover', 'originals/source/new', 'new.png', 'image/png', 24, 2, 3, 'verified', 'source_cover', 'originals/source/new', 'image/png');
select extensions.throws_like(
  $$insert into app_private.media_derivatives (asset_id, spec, authority_state, state, kind) values ('41000000-0000-4000-8000-000000000002', null, 'verified', 'pending', 'thumbnail_webp')$$,
  '%verified media derivative must use thumb_webp_v1 spec%',
  'verified derivative 第一筆 NULL spec 即拒絕，無法建立多筆 NULL duplicate'
);
insert into app_private.media_derivatives (asset_id, spec, authority_state, state, kind) values
  ('41000000-0000-4000-8000-000000000001', 'thumb_webp_v1', 'verified', 'pending', 'thumbnail_webp'),
  ('41000000-0000-4000-8000-000000000002', 'thumb_webp_v1', 'verified', 'pending', 'thumbnail_webp');
update app_private.media_ingests
set state = 'finalized', lease_token = null, lease_until = null, finalized_at = now()
where id in ('21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002');
set constraints app_private.media_assets_valid_references immediate;
update app_private.external_game_identities
set source_cover_asset_id = '41000000-0000-4000-8000-000000000001'
where id = '11000000-0000-4000-8000-000000000001';

select extensions.throws_like(
  $$update app_private.games set external_game_identity_id = null where id = '10000000-0000-4000-8000-000000000001'$$,
  '%game external identity must preserve its current source cover relationship%',
  '不可單獨 unlink 仍有 current source cover 的 game identity'
);
update app_private.games set external_game_identity_id = '11000000-0000-4000-8000-000000000001' where id = '10000000-0000-4000-8000-000000000001';
select extensions.lives_ok(
  $sql$do $unlink$
  begin
    set constraints all deferred;
    update app_private.external_game_identities set source_cover_asset_id = null where id = '11000000-0000-4000-8000-000000000001';
    update app_private.games set external_game_identity_id = null where id = '10000000-0000-4000-8000-000000000001';
    set constraints all immediate;
  end
  $unlink$$sql$,
  '同交易清除來源封面指標後可 unlink identity'
);
select extensions.lives_ok(
  $sql$do $relink$
  begin
    set constraints all deferred;
    update app_private.games set external_game_identity_id = '11000000-0000-4000-8000-000000000001' where id = '10000000-0000-4000-8000-000000000001';
    update app_private.external_game_identities set source_cover_asset_id = '41000000-0000-4000-8000-000000000001' where id = '11000000-0000-4000-8000-000000000001';
    set constraints all immediate;
  end
  $relink$$sql$,
  '同交易 relink identity 並恢復其 current source cover 可行'
);

select extensions.throws_like(
  $$update app_private.media_assets set superseded_at = now() where id = '41000000-0000-4000-8000-000000000001'$$,
  '%current source cover cannot be superseded%',
  '目前來源封面不可單獨標成 superseded'
);
update app_private.media_assets set superseded_at = null where id = '41000000-0000-4000-8000-000000000001';

select extensions.lives_ok(
  $sql$do $switch$
  begin
    set constraints all deferred;
    update app_private.external_game_identities
    set source_cover_asset_id = '41000000-0000-4000-8000-000000000002'
    where id = '11000000-0000-4000-8000-000000000001';
    update app_private.media_assets set superseded_at = now() where id = '41000000-0000-4000-8000-000000000001';
    set constraints all immediate;
  end
  $switch$$sql$,
  '同交易切換來源指標後可 supersede 舊來源封面'
);
select extensions.throws_like(
  $$update app_private.external_game_identities set source_cover_asset_id = '41000000-0000-4000-8000-000000000001' where id = '11000000-0000-4000-8000-000000000001'$$,
  '%media source cover must reference the identity current source image%',
  '來源封面指標不可重新指向已 superseded 資產'
);
select ok(
  (select source_cover_asset_id = '41000000-0000-4000-8000-000000000002' from app_private.external_game_identities where id = '11000000-0000-4000-8000-000000000001') and
  (select superseded_at is not null from app_private.media_assets where id = '41000000-0000-4000-8000-000000000001'),
  '切換後新來源封面是 current，舊來源封面保留為 superseded'
);

select extensions.throws_like(
  $$update app_private.media_derivatives set asset_id = '41000000-0000-4000-8000-000000000002' where asset_id = '40000000-0000-4000-8000-000000000001'$$,
  '%verified media derivative identity fields are immutable%',
  'verified derivative 不可跨 asset 重接'
);
select extensions.throws_like(
  $$update app_private.media_derivatives set authority_state = 'legacy_unverified' where asset_id = '40000000-0000-4000-8000-000000000001'$$,
  '%verified media derivative identity fields are immutable%',
  'verified derivative 不可降級 authority'
);
update app_private.media_derivatives set authority_state = 'verified' where asset_id = '40000000-0000-4000-8000-000000000001';

insert into app_private.media_ingests (id, game_id, source_url, object_key, original_state, thumbnail_state)
values ('22000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'https://legacy.example/cover', 'legacy/source/cover', 'ready', 'ready');
insert into app_private.media_assets (id, ingest_id, kind, object_key, mime_type, byte_size)
values ('42000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'source_cover', 'legacy/source/cover', 'image/png', 24);
insert into app_private.media_derivatives (id, asset_id, kind, object_key, state)
values ('43000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'thumbnail_webp', 'legacy/source/thumb', 'ready');
delete from app_private.media_ingests where id = '22000000-0000-4000-8000-000000000001';
select ok(
  not exists(select 1 from app_private.media_ingests where id = '22000000-0000-4000-8000-000000000001') and
  not exists(select 1 from app_private.media_assets where id = '42000000-0000-4000-8000-000000000001') and
  not exists(select 1 from app_private.media_derivatives where id = '43000000-0000-4000-8000-000000000001'),
  'legacy ingest 維持既有 cascade 刪除語意'
);

select extensions.throws_like(
  $$delete from app_private.media_ingests where id = '20000000-0000-4000-8000-000000000001'$$,
  '%cannot delete finalized media ingest%',
  'app_runtime 不可刪除 finalized ingest'
);
select ok(
  exists(select 1 from app_private.media_ingests where id = '20000000-0000-4000-8000-000000000001') and
  exists(select 1 from app_private.media_assets where id = '40000000-0000-4000-8000-000000000001') and
  exists(select 1 from app_private.media_derivatives where asset_id = '40000000-0000-4000-8000-000000000001'),
  '拒絕刪除後 ingest、asset 與 derivative 全數保留'
);

reset role;
select * from finish();
rollback;

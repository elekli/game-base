begin;
select plan(7);
select has_table('app_private', 'bgg_current_metrics', 'BGG 最新指標表存在');
select has_column('app_private', 'source_contributions', 'contributor_id', '來源貢獻連到共用貢獻者');
select ok(to_regclass('app_private.contributors_source_identity_unique') is not null, '來源貢獻者身分唯一索引存在');

grant app_runtime to postgres;
grant usage on schema extensions to app_runtime;
set local role app_runtime;
insert into app_private.external_game_identities (id, provider, source_id, medium, snapshot) values ('00000000-0000-0000-0000-000000000003', 'bgg', '9001', 'board_game', '{}'::jsonb);
insert into app_private.bgg_current_metrics (identity_id, weight, strategy_rank, last_successful_sync_at) values ('00000000-0000-0000-0000-000000000003', 3.25, 12, now());
select ok((select weight from app_private.bgg_current_metrics where identity_id = '00000000-0000-0000-0000-000000000003') = 3.25, 'BGG 重度可保存');
select ok((select strategy_rank from app_private.bgg_current_metrics where identity_id = '00000000-0000-0000-0000-000000000003') = 12, 'BGG 策略排名可保存');
select extensions.throws_like($$insert into app_private.bgg_current_metrics (identity_id, weight) values ('00000000-0000-0000-0000-000000000003', 6)$$, '%violates check constraint%', 'BGG 重度範圍受約束');
select ok((select count(*) from app_private.bgg_current_metrics where identity_id = '00000000-0000-0000-0000-000000000003') = 1, '來源更新失敗時舊指標仍存在');
reset role;
select * from finish();
rollback;

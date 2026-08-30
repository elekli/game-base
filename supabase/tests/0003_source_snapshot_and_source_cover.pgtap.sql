create extension if not exists pgtap;

select plan(7);
select has_table('app_private', 'source_categories', '來源分類表存在');
select has_table('app_private', 'external_game_categories', '來源分類關聯表存在');
select has_table('app_private', 'source_contributions', '來源貢獻表存在');
select has_table('app_private', 'external_player_profiles', '玩家資料表存在');
select has_table('app_private', 'media_ingests', '媒體匯入表存在');
select has_table('app_private', 'media_assets', '媒體原檔表存在');
select has_table('app_private', 'media_derivatives', '媒體衍生檔表存在');
select * from finish();

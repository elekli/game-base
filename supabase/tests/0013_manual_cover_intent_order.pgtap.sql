begin;
select plan(2);

select has_column('app_private', 'games', 'manual_cover_selected_at', '遊戲保留人工封面 intent 時序');
select col_is_null('app_private', 'games', 'manual_cover_selected_at', '人工封面 intent 時序採安全的可空擴充');

select * from finish();
rollback;

grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.games
  add column manual_cover_selected_at timestamptz default '-infinity'::timestamptz;

reset role;
revoke app_migrator from postgres;

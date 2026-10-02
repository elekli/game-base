grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.command_receipts
  drop constraint command_receipts_command_kind_check;

alter table app_private.command_receipts
  add constraint command_receipts_command_kind_check
  check (command_kind in ('game.edit', 'game.trash', 'game.restore'));

reset role;
revoke app_migrator from postgres;

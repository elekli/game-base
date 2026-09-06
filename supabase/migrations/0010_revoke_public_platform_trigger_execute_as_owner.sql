grant app_migrator to postgres;
set local role app_migrator;
revoke execute on function app_private.prevent_system_platform_mutation() from public;
reset role;
revoke app_migrator from postgres;

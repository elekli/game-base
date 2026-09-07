import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DATABASE_CONTAINER = "supabase_db_puizeru-gamebase";
const PROBE_DUMP = "/tmp/puizeru-production-restore-role-probe.dump";

async function runInDatabaseContainer(argv: string[]) {
  return execFileAsync("docker", [
    "exec",
    "--env",
    "PGPASSWORD=postgres",
    DATABASE_CONTAINER,
    ...argv,
  ]);
}

async function psql(sql: string) {
  return runInDatabaseContainer([
    "psql",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  ]);
}

async function restoreProbe() {
  return runInDatabaseContainer([
    "pg_restore",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--role=app_migrator",
    "--data-only",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    PROBE_DUMP,
  ]);
}

beforeAll(async () => {
  await psql(`
    grant app_migrator to postgres;
    set role app_migrator;
    delete from app_private.production_smoke_canaries;
    insert into app_private.production_smoke_canaries (
      id, identity, generation, action_sequence, payload_sha256, phase
    ) values (
      '7355773e-c3b5-4e5d-9f07-55ac0e22f384',
      'release-smoke-v1:' || repeat('a', 40),
      '11111111-1111-4111-8111-111111111111',
      1,
      repeat('b', 64),
      'row_claimed'
    );
    reset role;
  `);
  await runInDatabaseContainer([
    "pg_dump",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--format=custom",
    "--data-only",
    "--table=app_private.production_smoke_canaries",
    `--file=${PROBE_DUMP}`,
  ]);
  await psql("truncate app_private.production_smoke_canaries;");
});

afterAll(async () => {
  await psql(`
    begin;
    grant app_migrator to postgres;
    set role app_migrator;
    alter table app_private.production_smoke_canaries force row level security;
    delete from app_private.production_smoke_canaries;
    reset role;
    revoke app_migrator from postgres;
    commit;
  `);
  await runInDatabaseContainer(["rm", "-f", PROBE_DUMP]);
});

describe("Production restore migration owner", () => {
  it("temporarily relaxes FORCE RLS for COPY and restores the original security boundary", async () => {
    await expect(restoreProbe()).rejects.toThrow();

    await psql(`
      begin;
      set role app_migrator;
      alter table app_private.production_smoke_canaries no force row level security;
      truncate app_private.production_smoke_canaries;
      reset role;
      commit;
    `);
    await expect(restoreProbe()).resolves.toBeDefined();
    await psql(`
      begin;
      set role app_migrator;
      alter table app_private.production_smoke_canaries force row level security;
      reset role;
      revoke app_migrator from postgres;
      commit;
    `);

    const { stdout } = await psql(`
      select json_build_object(
        'rowCount', (select count(*) from app_private.production_smoke_canaries),
        'forceRls', (select relforcerowsecurity from pg_class where oid = 'app_private.production_smoke_canaries'::regclass),
        'temporaryMembershipCount', (
          select count(*)
          from pg_auth_members membership
          join pg_roles member_role on member_role.oid = membership.member
          join pg_roles granted_role on granted_role.oid = membership.roleid
          join pg_roles grantor_role on grantor_role.oid = membership.grantor
          where member_role.rolname = 'postgres'
            and granted_role.rolname = 'app_migrator'
            and grantor_role.rolname = 'postgres'
        )
      );
    `);

    expect(JSON.parse(stdout.trim())).toEqual({
      rowCount: 1,
      forceRls: true,
      temporaryMembershipCount: 0,
    });
  });
});

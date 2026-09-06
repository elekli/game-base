import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatProductionMigrationFailure,
  lintProductionMigrations,
  ProductionMigrationError,
  runProductionMigrationPreflight,
  validateProductionMigrationConnection,
  type ProductionDatabaseSnapshot,
  type ReadOnlyDatabaseSession,
} from "../../scripts/production-migration-preflight";

const productionBinding = {
  databaseName: "postgres",
  projectRef: "wbtyuvufhrhybquzwfip",
  supavisorHost: "aws-0-ap-south-1.pooler.supabase.com",
};
const appPrivateTables = [
  "bgg_current_metrics",
  "contributors",
  "external_game_categories",
  "external_game_identities",
  "external_player_profiles",
  "external_supported_platforms",
  "game_names",
  "game_platforms",
  "game_tags",
  "games",
  "manual_contributions",
  "media_assets",
  "media_derivatives",
  "media_ingests",
  "platforms",
  "source_categories",
  "source_contributions",
  "tags",
] as const;

async function migrationFixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), "migration-preflight-"));
  const directory = path.join(root, "supabase", "migrations");
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, ".github"), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, sql]) =>
      writeFile(path.join(directory, name), sql),
    ),
  );
  await writeFile(
    path.join(root, ".github", "production-rls-policy-manifest.json"),
    JSON.stringify({
      schema: "app_private",
      policies: [
        {
          table: "games",
          name: "runtime_games",
          validFrom: "0002",
          validUntilExclusive: null,
          permissiveness: "PERMISSIVE",
          command: "ALL",
          roles: ["app_runtime"],
          using: "true",
          withCheck: "true",
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, ".github", "production-runtime-role-reachability-allowlist.json"),
    JSON.stringify({ appRuntimeReachableRoles: [] }),
  );
  return root;
}

function healthySnapshot(): ProductionDatabaseSnapshot {
  return {
    migrations: [
      { version: "0001", name: "runtime_security" },
      { version: "0002", name: "games" },
    ],
    appMigratorExists: true,
    appMigratorIsRestricted: true,
    appMigratorReachableRoles: [],
    appRuntimeExists: true,
    appRuntimeIsRestricted: true,
    appRuntimeReachableRoles: [],
    expectedCreatorAdminMembershipCount: 2,
    appPrivateOwnedByMigrator: true,
    appPrivateObjects: [
      ...appPrivateTables.map((identity) => ({
        kind: "table",
        identity,
        owner: "app_migrator",
        extensionOwned: false,
      })),
      {
        kind: "function",
        identity: "app_private.prevent_system_platform_mutation()",
        owner: "app_migrator",
        extensionOwned: false,
      },
    ],
    dangerousInboundRoleCount: 0,
    unexpectedAclCount: 0,
    defaultPrivilegeDriftCount: 0,
    unsafeGrantCount: 0,
    knownPublicExecuteDriftCount: 0,
    appRuntimeCanExecuteKnownDriftFunction: false,
    appRuntimeDirectExecuteGrantCount: 0,
    missingRuntimeGrantCount: 0,
    rlsDisabledCount: 0,
    rlsPolicies: [
      {
        table: "games",
        name: "runtime_games",
        permissiveness: "PERMISSIVE",
        command: "ALL",
        roles: ["app_runtime"],
        using: "true",
        withCheck: "true",
      },
    ],
    bucketExists: true,
    bucketIsPrivate: true,
    bucketFileSizeLimit: 52_428_800,
    storageObjectsRlsEnabled: true,
  };
}

describe("production migration safety lint", () => {
  it("accepts additive migrations", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create table app_private.games (id uuid primary key);",
      "0002_expand.sql": "alter table app_private.games add column note text;",
    });

    await expect(lintProductionMigrations(root)).resolves.toEqual({
      migrationCount: 2,
    });
  });

  it.each([
    "drop table app_private.games",
    "drop index app_private.games_title_idx",
    "drop sequence app_private.games_id_seq",
    "drop domain app_private.game_slug",
    "drop rule game_write on app_private.games",
    "drop extension pgcrypto",
    "drop role app_runtime",
    "drop database postgres",
    "drop owned by app_runtime",
    "reassign owned by app_runtime to app_migrator",
    "drop policy runtime_games on app_private.games",
    "alter table app_private.games drop column title",
    "alter table app_private.games add constraint title_unique unique (title)",
    "alter table app_private.games add unique (title)",
    "alter table app_private.games add check (title <> '')",
    "alter table app_private.games add foreign key (parent_id) references app_private.games (id)",
    "alter table app_private.games add primary key (id)",
    "alter table app_private.games validate constraint games_title_check",
    "alter table app_private.games alter constraint games_parent_id_fkey deferrable",
    "alter table app_private.games add column title text not null",
    "alter table app_private.games disable row level security",
    "alter table app_private.games disable trigger prevent_system_platform_mutation",
    "alter table app_private.games disable rule game_write_guard",
    "alter table app_private.games alter column title type varchar(50)",
    "alter table app_private.games alter column title set not null",
    "alter table app_private.games alter title type varchar(50)",
    "alter table app_private.games alter title set not null",
    "truncate table app_private.games",
    "create unique index games_title_unique on app_private.games (title)",
    "alter table app_private.games rename column title to name",
    "alter table app_private.games rename title to name",
    "alter table app_private.games rename to video_games",
    "alter view app_private.game_summary rename to game_overview",
    "alter sequence app_private.games_id_seq rename to game_ids_seq",
    "alter index app_private.games_title_idx rename to game_name_idx",
    "alter table app_private.games owner to app_runtime",
    "create role reporting_role",
    "create user reporting_user",
    "create group reporting_group",
    "alter role app_runtime superuser",
    "grant app_migrator to app_runtime",
    "revoke select on app_private.games from app_runtime",
    "alter default privileges in schema app_private grant select on tables to reporting_role",
    "alter domain app_private.game_slug set not null",
    "alter domain app_private.game_slug add constraint slug_check check (value <> '')",
    "alter policy runtime_games on app_private.games using (false)",
    "create policy runtime_games on app_private.games as restrictive for select using (false)",
  ])("rejects unsplit destructive DDL: %s", async (ddl) => {
    const root = await migrationFixture({ "0001_contract.sql": `${ddl};` });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("ignores SQL-looking text inside comments and strings", async () => {
    const root = await migrationFixture({
      "0001_safe_strings.sql": `
        -- drop table app_private.games;
        -- alter table app_private.games rename to archived_games;
        -- reassign owned by app_runtime to app_migrator;
        -- alter table app_private.games add unique (title);
        -- alter table app_private.games validate constraint games_title_check;
        -- alter policy runtime_games on app_private.games using (false);
        -- alter table app_private.games disable trigger prevent_system_platform_mutation;
        select 'it''s not -- a comment: drop table app_private.games';
        select 'alter view app_private.game_summary rename to archived_summary';
        select 'reassign owned by app_runtime to app_migrator';
        select 'alter table app_private.games add check (title <> '''')';
        select 'alter table app_private.games add foreign key (parent_id) references app_private.games (id)';
        select 'alter table app_private.games add primary key (id)';
        select 'alter table app_private.games alter constraint games_parent_id_fkey deferrable';
        select 'create policy runtime_games on app_private.games as restrictive using (false)';
        select 'alter table app_private.games disable rule game_write_guard';
        select E'escaped\\' quote /* still text */ drop table app_private.games';
        select $$drop table app_private.games;$$;
        create function app_private.example() returns text language sql as
          $body$ select 'drop table app_private.games; alter table games rename to old_games'; $body$;
      `,
    });

    await expect(lintProductionMigrations(root)).resolves.toEqual({
      migrationCount: 1,
    });
  });

  it.each([
    "alter table app_private.games validate constraint games_title_check",
    "alter table app_private.games alter constraint games_parent_id_fkey deferrable",
    "alter policy runtime_games on app_private.games using (false)",
    "create policy runtime_games on app_private.games as restrictive using (false)",
    "alter table app_private.games disable trigger prevent_system_platform_mutation",
    "alter table app_private.games disable rule game_write_guard",
  ])("rejects two-phase contract violations inside routine bodies: %s", async (ddl) => {
    const root = await migrationFixture({
      "0001_dynamic.sql": `
        create procedure app_private.contract_violation() language plpgsql as $body$
        begin
          ${ddl};
        end
        $body$;
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects executable REASSIGN OWNED inside a routine body", async () => {
    const root = await migrationFixture({
      "0001_dynamic.sql": `
        create procedure app_private.reassign_objects() language plpgsql as $body$
        begin
          reassign owned by app_runtime to app_migrator;
        end
        $body$;
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects procedural DO with dynamic EXECUTE", async () => {
    const root = await migrationFixture({
      "0001_dynamic.sql": "DO $$ BEGIN EXECUTE 'drop table app_private.games'; END $$;",
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("allows only the named byte-exact grant remediation", async () => {
    const sql =
      "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n";
    const approved = await migrationFixture({
      "0001_revoke_public_platform_trigger_execute.sql": sql,
    });
    const unnamed = await migrationFixture({ "0001_other.sql": sql });

    await expect(lintProductionMigrations(approved)).resolves.toEqual({
      migrationCount: 1,
    });
    await expect(lintProductionMigrations(unnamed)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects dynamic EXECUTE hidden in a dollar-quoted function body", async () => {
    const root = await migrationFixture({
      "0001_dynamic_function.sql": `
        create function app_private.dynamic_drop() returns void language plpgsql as
        $fn$ begin execute 'drop table app_private.games'; end $fn$;
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects dynamic EXECUTE hidden in an E-string function body", async () => {
    const root = await migrationFixture({
      "0001_dynamic_e_string_function.sql": `
        create function app_private.fn() returns void language plpgsql as
          E'begin execute ''drop table app_private.games''; end';
        select app_private.fn();
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it.each([
    String.raw`E'begin \145xecute ''drop table app_private.games''; end'`,
    String.raw`E'begin \x65xecute ''drop table app_private.games''; end'`,
    String.raw`'begin \145xecute ''drop table app_private.games''; end'`,
  ])("rejects routine body escape forms instead of partially decoding %s", async (body) => {
    const root = await migrationFixture({
      "0001_escaped_function.sql": `
        create function app_private.fn() returns void language plpgsql as ${body};
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects adjacent routine body literals joined across a newline", async () => {
    const root = await migrationFixture({
      "0001_adjacent_function.sql": `
        create function app_private.fn() returns void language plpgsql as
          'begin ex'
          'ecute ''drop table app_private.games''; end';
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects a U& routine body instead of attempting partial escape decoding", async () => {
    const root = await migrationFixture({
      "0001_unicode_escape_function.sql": `
        create function app_private.fn() returns void language plpgsql as
          U&'begin !0065xecute ''drop table app_private.games''; end' UESCAPE '!';
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects even a safe-looking standard-string routine body", async () => {
    const root = await migrationFixture({
      "0001_standard_string_function.sql": `
        create function app_private.fn() returns integer language sql as 'select 1';
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects dynamic EXECUTE hidden in a standard-string procedure body", async () => {
    const root = await migrationFixture({
      "0001_dynamic_string_procedure.sql": `
        create procedure app_private.fn() language plpgsql as
          'begin execute ''drop table app_private.games''; end';
      `,
    });

    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("grandfathers only the exact hash of an already-applied migration", async () => {
    const ddl = "alter table app_private.games alter column title set not null;";
    const root = await migrationFixture({ "0001_legacy.sql": ddl });
    await mkdir(path.join(root, ".github"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "production-migration-lint-baseline.json"),
      JSON.stringify({
        "0001_legacy.sql": "a3b4da9300b0972640fc810215247b482f31434ebcff87bd52b4424262721232",
      }),
    );

    await expect(lintProductionMigrations(root)).resolves.toEqual({
      migrationCount: 1,
    });
    await writeFile(
      path.join(root, "supabase", "migrations", "0001_legacy.sql"),
      `${ddl}\n-- changed`,
    );
    await expect(lintProductionMigrations(root)).rejects.toThrow(
      "ProductionMigrationSafetyError",
    );
  });

  it("rejects changing the destructive-DDL baseline relative to main", async () => {
    const ddl = "drop table app_private.games;";
    const root = await migrationFixture({ "0001_legacy.sql": ddl });
    await mkdir(path.join(root, ".github"), { recursive: true });
    const candidateBaseline = JSON.stringify({
      "0001_legacy.sql": createHash("sha256").update(ddl).digest("hex"),
    });
    await writeFile(
      path.join(root, ".github", "production-migration-lint-baseline.json"),
      candidateBaseline,
    );

    await expect(
      lintProductionMigrations(root, { trustedBaselineText: "{}" }),
    ).rejects.toThrow("ProductionMigrationSafetyError");
  });

  it.each(["modified", "deleted"])(
    "rejects a %s migration tracked by trusted main",
    async (change) => {
      const original = "create table app_private.games (id uuid primary key);";
      const root = await migrationFixture(
        change === "deleted"
          ? { "0002_new.sql": "select 1;" }
          : { "0001_runtime_security.sql": `${original}\n-- changed` },
      );

      await expect(
        lintProductionMigrations(root, {
          trustedMigrationTexts: { "0001_runtime_security.sql": original },
        }),
      ).rejects.toThrow("ProductionMigrationSafetyError");
    },
  );
});

describe("production migration connection binding", () => {
  it("accepts the bound session pooler on port 5432", () => {
    expect(
      validateProductionMigrationConnection(
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        productionBinding,
      ),
    ).toEqual({ connectionMode: "session", projectRef: "wbtyuvufhrhybquzwfip" });
  });

  it("rejects the transaction pooler and runtime role", () => {
    expect(() =>
      validateProductionMigrationConnection(
        "postgres://app_runtime.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
        productionBinding,
      ),
    ).toThrow("ProductionMigrationConnectionError");
  });

  it("rejects a connection that does not require TLS", () => {
    expect(() =>
      validateProductionMigrationConnection(
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=disable",
        productionBinding,
      ),
    ).toThrow("ProductionMigrationConnectionError");
  });

  it("rejects TLS encryption without certificate verification", () => {
    expect(() =>
      validateProductionMigrationConnection(
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require",
        productionBinding,
      ),
    ).toThrow("ProductionMigrationConnectionError");
  });
});

describe("production migration preflight", () => {
  it("opens a read-only transaction and returns only allowlisted evidence", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const statements: string[] = [];
    const snapshot = healthySnapshot();
    expect(snapshot.appPrivateObjects.filter((object) => object.kind === "table")).toHaveLength(18);
    expect(snapshot.appPrivateObjects.filter((object) => object.kind === "function")).toHaveLength(1);
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        if (sql.includes("json_build_object")) {
          return [{ snapshot }] as T[];
        }
        return [];
      },
      async release() {},
    };

    const result = await runProductionMigrationPreflight({
      root,
      databaseUrl:
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
      connect: async () => session,
    });

    expect(statements[0]).toMatch(/^begin transaction read only/i);
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.join("\n")).toContain("from pg_class c");
    expect(statements.join("\n")).toContain("from pg_proc procedure");
    expect(statements.join("\n")).toContain("from pg_type object_type");
    expect(statements.join("\n")).toContain(
      "has_table_privilege('app_runtime', c.oid, 'DELETE')",
    );
    expect(statements.join("\n")).not.toContain("'SELECT,INSERT,UPDATE,DELETE'");
    expect(statements.join("\n")).not.toContain("'USAGE,SELECT'");
    expect(result).toEqual({
      projectRef: "wbtyuvufhrhybquzwfip",
      connectionMode: "session",
      migrationCount: 2,
      appliedMigrationCount: 2,
      pendingMigrationCount: 0,
      preflightState: "strict",
      roleChecks: "passed",
      objectOwnerChecks: "passed",
      grantChecks: "passed",
      rlsChecks: "passed",
      privateBucketCheck: "passed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports a repository suffix as pending without changing Production", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_notes.sql": "create table app_private.notes (id uuid primary key);",
    });
    await writeFile(
      path.join(root, ".github", "production-rls-policy-manifest.json"),
      JSON.stringify({
        schema: "app_private",
        policies: [
          {
            table: "games",
            name: "runtime_games",
            validFrom: "0002",
            validUntilExclusive: null,
            permissiveness: "PERMISSIVE",
            command: "ALL",
            roles: ["app_runtime"],
            using: "true",
            withCheck: "true",
          },
          {
            table: "notes",
            name: "runtime_notes",
            validFrom: "0003",
            validUntilExclusive: null,
            permissiveness: "PERMISSIVE",
            command: "ALL",
            roles: ["app_runtime"],
            using: "true",
            withCheck: "true",
          },
        ],
      }),
    );
    const statements: string[] = [];
    const snapshot = healthySnapshot();
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object")
          ? ([{ snapshot }] as T[])
          : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).resolves.toMatchObject({
      appliedMigrationCount: 2,
      pendingMigrationCount: 1,
    });
    expect(statements.at(-1)).toBe("rollback");
  });

  it("selects the RLS policy revision active at the applied or strict tail", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0007_checkpoint.sql": "select 1;",
      "0008_policy_manifest_checkpoint.sql": "select 1;",
    });
    await writeFile(
      path.join(root, ".github", "production-rls-policy-manifest.json"),
      JSON.stringify({
        schema: "app_private",
        policies: [
          {
            table: "games",
            name: "runtime_games",
            validFrom: "0002",
            validUntilExclusive: "0008",
            permissiveness: "PERMISSIVE",
            command: "ALL",
            roles: ["app_runtime"],
            using: "true",
            withCheck: "true",
          },
          {
            table: "games",
            name: "runtime_games",
            validFrom: "0008",
            validUntilExclusive: null,
            permissiveness: "PERMISSIVE",
            command: "ALL",
            roles: ["app_runtime"],
            using: "new_expression",
            withCheck: "new_expression",
          },
        ],
      }),
    );
    const oldPolicySnapshot = healthySnapshot();
    oldPolicySnapshot.migrations.push({ version: "0007", name: "checkpoint" });
    const newPolicySnapshot: ProductionDatabaseSnapshot = {
      ...oldPolicySnapshot,
      rlsPolicies: [
        {
          ...oldPolicySnapshot.rlsPolicies[0]!,
          using: "new_expression",
          withCheck: "new_expression",
        },
      ],
    };
    const sessionFor = (snapshot: ProductionDatabaseSnapshot): ReadOnlyDatabaseSession => ({
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    });
    const optionsFor = (snapshot: ProductionDatabaseSnapshot) => ({
      root,
      databaseUrl:
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
      connect: async () => sessionFor(snapshot),
    });

    await expect(runProductionMigrationPreflight(optionsFor(oldPolicySnapshot))).resolves.toMatchObject({
      appliedMigrationCount: 3,
      pendingMigrationCount: 1,
    });
    await expect(
      runProductionMigrationPreflight(optionsFor(newPolicySnapshot)),
    ).rejects.toThrow("ProductionMigrationPreflightError");

    newPolicySnapshot.migrations.push({
      version: "0008",
      name: "policy_manifest_checkpoint",
    });
    await expect(
      runProductionMigrationPreflight({
        ...optionsFor(newPolicySnapshot),
        phase: "strict",
      }),
    ).resolves.toMatchObject({ pendingMigrationCount: 0 });
    oldPolicySnapshot.migrations.push({
      version: "0008",
      name: "policy_manifest_checkpoint",
    });
    await expect(
      runProductionMigrationPreflight({
        ...optionsFor(oldPolicySnapshot),
        phase: "strict",
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it.each([
    ["gap", "0007"],
    ["overlap", "0009"],
  ])("rejects an RLS policy revision %s", async (_case, firstRevisionEnd) => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0007_before.sql": "select 1;",
      "0008_change.sql": "select 1;",
      "0009_after.sql": "select 1;",
    });
    const revision = (validFrom: string, validUntilExclusive: string | null) => ({
      table: "games",
      name: "runtime_games",
      validFrom,
      validUntilExclusive,
      permissiveness: "PERMISSIVE",
      command: "ALL",
      roles: ["app_runtime"],
      using: "true",
      withCheck: "true",
    });
    await writeFile(
      path.join(root, ".github", "production-rls-policy-manifest.json"),
      JSON.stringify({
        schema: "app_private",
        policies: [revision("0002", firstRevisionEnd), revision("0008", null)],
      }),
    );

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => {
          throw new Error("must fail before connecting");
        },
      }),
    ).rejects.toThrow("ProductionMigrationSafetyError");
  });

  it("fails closed when applied history diverges from the repository", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const statements: string[] = [];
    const snapshot = healthySnapshot();
    snapshot.migrations = [{ version: "0001", name: "different_name" }];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    expect(statements.at(-1)).toBe("rollback");
  });

  it("rejects trusted migration byte drift before opening a database connection", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "select 2;",
      "0002_games.sql": "select 1;",
    });
    let connected = false;

    await expect(
      runProductionMigrationPreflight({
        root,
        trustedMigrationTexts: { "0001_runtime_security.sql": "select 1;" },
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => {
          connected = true;
          throw new Error("must not connect");
        },
      }),
    ).rejects.toThrow("ProductionMigrationSafetyError");
    expect(connected).toBe(false);
  });

  it("rejects a direct INHERIT-only membership in app_migrator", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appRuntimeReachableRoles = [
      {
        name: "app_migrator",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
      },
    ];
    const statements: string[] = [];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    expect(statements.join("\n").match(/membership\.inherit_option/g)).toHaveLength(7);
  });

  it("rejects every role reachable outward from app_migrator", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appMigratorReachableRoles = [
      {
        name: "postgres",
        isSuperuser: true,
        bypassRls: true,
        canCreateRole: true,
        canCreateDatabase: true,
      },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it.each([
    ["direct reverse membership", "dangerousInboundRoleCount"],
    ["recursive reverse membership", "dangerousInboundRoleCount"],
    ["unexpected object ACL", "unexpectedAclCount"],
    ["default privilege drift", "defaultPrivilegeDriftCount"],
  ] as const)("rejects %s", async (_case, field) => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot[field] = 1;
    const statements: string[] = [];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    if (field === "dangerousInboundRoleCount") {
      expect(statements.join("\n")).toContain("with recursive inbound_role");
    }
  });

  it("requires exactly the two PostgreSQL role-creator ADMIN memberships", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.expectedCreatorAdminMembershipCount = 1;
    const statements: string[] = [];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    expect(statements.join("\n")).toContain("membership.admin_option");
  });

  it("requires app_migrator to keep all restricted role flags", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appMigratorIsRestricted = false;
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("rejects an app_private table owned by app_runtime", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appPrivateObjects = snapshot.appPrivateObjects.map((object) =>
      object.kind === "table" && object.identity === "games"
        ? { ...object, owner: "app_runtime" }
        : object,
    );
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it.each([
    ["function", "app_private.prevent_system_platform_mutation()"],
    ["sequence", "games_legacy_id_seq"],
  ])("rejects an app_private %s owned by another role", async (kind, identity) => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appPrivateObjects = [
      ...snapshot.appPrivateObjects.filter((object) => object.kind !== kind),
      {
        kind,
        identity,
        owner: "unexpected_owner",
        extensionOwned: false,
      },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("fails closed on extension-owned objects inside app_private", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appPrivateObjects.push({
      kind: "type",
      identity: "extension_type",
      owner: "app_migrator",
      extensionOwned: true,
    });
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("rejects app_migrator reached through recursive INHERIT-only memberships", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    await writeFile(
      path.join(root, ".github", "production-runtime-role-reachability-allowlist.json"),
      JSON.stringify({ appRuntimeReachableRoles: ["reporting_role"] }),
    );
    const snapshot = healthySnapshot();
    snapshot.appRuntimeReachableRoles = [
      {
        name: "reporting_role",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
      },
      {
        name: "app_migrator",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
      },
    ];
    const statements: string[] = [];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    expect(statements.join("\n")).toContain("with recursive reachable_role");
    expect(statements.join("\n")).toContain("membership.set_option");
    expect(statements.join("\n")).toContain("membership.inherit_option");
    expect(statements.join("\n").match(/membership\.inherit_option/g)).toHaveLength(7);
  });

  it.each([
    ["isSuperuser"],
    ["bypassRls"],
    ["canCreateRole"],
    ["canCreateDatabase"],
  ] as const)("rejects an allowlisted role with %s", async (privilege) => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    await writeFile(
      path.join(root, ".github", "production-runtime-role-reachability-allowlist.json"),
      JSON.stringify({ appRuntimeReachableRoles: ["reporting_role"] }),
    );
    const snapshot = healthySnapshot();
    snapshot.appRuntimeReachableRoles = [
      {
        name: "reporting_role",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
        [privilege]: true,
      },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("rejects an unapproved reachable role without elevated flags", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.appRuntimeReachableRoles = [
      {
        name: "reporting_role",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
      },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("requires strict verification to observe a revoked runtime membership", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_revoke_public_platform_trigger_execute.sql":
        "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n",
    });
    const snapshot = healthySnapshot();
    snapshot.migrations.push({
      version: "0003",
      name: "revoke_public_platform_trigger_execute",
    });
    snapshot.appRuntimeReachableRoles = [
      {
        name: "app_migrator",
        isSuperuser: false,
        bypassRls: false,
        canCreateRole: false,
        canCreateDatabase: false,
      },
    ];
    const sessionFor = (): ReadOnlyDatabaseSession => ({
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    });
    const options = {
      root,
      phase: "strict" as const,
      databaseUrl:
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    };

    await expect(
      runProductionMigrationPreflight({ ...options, connect: async () => sessionFor() }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
    snapshot.appRuntimeReachableRoles = [];
    await expect(
      runProductionMigrationPreflight({ ...options, connect: async () => sessionFor() }),
    ).resolves.toMatchObject({ preflightState: "strict" });
  });

  it("fails closed when an applicable RLS policy replaces the required policy", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.rlsPolicies = [
      {
        table: "games",
        name: "replacement",
        permissiveness: "PERMISSIVE",
        command: "SELECT",
        roles: ["app_runtime"],
        using: "false",
        withCheck: null,
      },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("snapshots RLS policy permissiveness", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    const statements: string[] = [];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        statements.push(sql);
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await runProductionMigrationPreflight({
      root,
      databaseUrl:
        "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
      connect: async () => session,
    });

    expect(statements.join("\n")).toContain("polpermissive");
  });

  it("fails closed when a required RLS policy becomes restrictive", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
    });
    const snapshot = healthySnapshot();
    snapshot.rlsPolicies = [
      { ...snapshot.rlsPolicies[0]!, permissiveness: "RESTRICTIVE" },
    ];
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("allows only the exact pending forward migration for the known PUBLIC drift", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_revoke_public_platform_trigger_execute.sql":
        "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n",
    });
    const snapshot = healthySnapshot();
    snapshot.unsafeGrantCount = 1;
    snapshot.knownPublicExecuteDriftCount = 1;
    snapshot.appRuntimeCanExecuteKnownDriftFunction = true;
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).resolves.toMatchObject({
      preflightState: "known-drift-remediation-required",
      pendingMigrationCount: 1,
    });
  });

  it("rejects known drift without the exact remediation-only migration", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_revoke_public_platform_trigger_execute.sql":
        "revoke execute on function app_private.prevent_system_platform_mutation() from public; select 1;",
    });
    const snapshot = healthySnapshot();
    snapshot.unsafeGrantCount = 1;
    snapshot.knownPublicExecuteDriftCount = 1;
    snapshot.appRuntimeCanExecuteKnownDriftFunction = true;
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationSafetyError");
  });

  it("rejects duplicate copies of the one-time remediation", async () => {
    const remediation =
      "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n";
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_revoke_public_platform_trigger_execute.sql": remediation,
      "0004_revoke_public_platform_trigger_execute.sql": remediation,
    });
    const snapshot = healthySnapshot();
    snapshot.unsafeGrantCount = 1;
    snapshot.knownPublicExecuteDriftCount = 1;
    snapshot.appRuntimeCanExecuteKnownDriftFunction = true;
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });

  it("requires strict post-migration verification and no app_runtime EXECUTE", async () => {
    const root = await migrationFixture({
      "0001_runtime_security.sql": "create schema app_private;",
      "0002_games.sql": "create table app_private.games (id uuid primary key);",
      "0003_revoke_public_platform_trigger_execute.sql":
        "revoke execute on function app_private.prevent_system_platform_mutation() from public;\n",
    });
    const snapshot = healthySnapshot();
    snapshot.migrations.push({
      version: "0003",
      name: "revoke_public_platform_trigger_execute",
    });
    const session: ReadOnlyDatabaseSession = {
      async unsafe<T>(sql: string) {
        return sql.includes("json_build_object") ? ([{ snapshot }] as T[]) : [];
      },
      async release() {},
    };

    await expect(
      runProductionMigrationPreflight({
        root,
        phase: "strict",
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).resolves.toMatchObject({ preflightState: "strict", pendingMigrationCount: 0 });

    snapshot.appRuntimeCanExecuteKnownDriftFunction = true;
    await expect(
      runProductionMigrationPreflight({
        root,
        phase: "strict",
        databaseUrl:
          "postgres://postgres.wbtyuvufhrhybquzwfip:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        connect: async () => session,
      }),
    ).rejects.toThrow("ProductionMigrationPreflightError");
  });
});

describe("production migration failure diagnostics", () => {
  it("emits a finite safe error name and actionable controlled detail", () => {
    const diagnostic = formatProductionMigrationFailure(
      new ProductionMigrationError(
        "ProductionMigrationPreflightError",
        "Production database failed checks: grants(unsafe=1,missing=0)",
      ),
    );

    expect(diagnostic).toEqual({
      event: "production_migration_preflight_failed",
      errorName: "ProductionMigrationPreflightError",
      detail: "Production database failed checks: grants(unsafe=1,missing=0)",
    });
  });

  it("does not expose unexpected driver messages", () => {
    const diagnostic = formatProductionMigrationFailure(
      new Error("postgres://owner:secret@example.test/postgres"),
    );

    expect(diagnostic).toEqual({
      event: "production_migration_preflight_failed",
      errorName: "ProductionMigrationUnexpectedError",
      detail: "unexpected preflight failure; inspect protected runner diagnostics",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });
});

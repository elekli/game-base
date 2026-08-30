import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const requiredPaths = [
  "src/app/layout.tsx",
  "src/shared/auth/private-request.ts",
  "src/shared/auth/require-owner.ts",
  "src/shared/config/deployment-bindings.ts",
  "src/shared/config/runtime-config.ts",
  "src/shared/observability/structured-log.ts",
  "scripts/preview-replay.ts",
  ".github/workflows/preview-supabase-replay.yml",
  "docs/deployment/preview-supabase-replay.md",
  "supabase/config.toml",
  "supabase/migrations/0001_runtime_security.sql",
  "supabase/tests/0001_runtime_security.pgtap.sql",
  "docs/security/CHECKLIST.md",
  "docs/security/SUPABASE.md",
] as const;

const missing: string[] = [];
for (const path of requiredPaths) {
  try {
    await access(path);
  } catch {
    missing.push(path);
  }
}

const violations: string[] = [];
if (missing.length > 0) violations.push(`missing:${missing.join(",")}`);

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const requiredScripts = [
  "lint",
  "typecheck",
  "test",
  "test:integration",
  "test:e2e",
  "integrity:check",
  "build",
  "preview:replay",
  "supabase:reset",
  "test:pgtap",
  "db:schema:pull",
  "db:schema:check",
];
for (const script of requiredScripts) {
  if (packageJson.scripts?.[script] === undefined) violations.push(`missing-script:${script}`);
}

const allScripts = Object.values(packageJson.scripts ?? {}).join("\n");
if (/drizzle-kit\s+(generate|migrate|push)/.test(allScripts)) {
  violations.push("drizzle-migration-authority");
}

const supabaseConfig = await readFile("supabase/config.toml", "utf8");
const supabaseConfigExpectations = [
  'schemas = ["graphql_public"]',
  "auto_expose_new_tables = false",
  "[auth]\nenabled = false",
  "[realtime]\nenabled = false",
  "[edge_runtime]\nenabled = false",
];
for (const expected of supabaseConfigExpectations) {
  if (!supabaseConfig.includes(expected)) violations.push(`supabase-config:${expected}`);
}

const migration = await readFile("supabase/migrations/0001_runtime_security.sql", "utf8");
const migrationExpectations = ["app_runtime", "nobypassrls", "app_private", "game-media", "52428800"];
for (const expected of migrationExpectations) {
  if (!migration.includes(expected)) violations.push(`migration:${expected}`);
}

const previewReplay = await readFile("scripts/preview-replay.ts", "utf8");
const previewReplayExpectations = [
  "RESET_PREVIEW_ONLY",
  '"--no-seed"',
  '"migration", "list"',
  '"test", "db"',
  "db.${projectRef}.supabase.co",
];
for (const expected of previewReplayExpectations) {
  if (!previewReplay.includes(expected)) violations.push(`preview-replay:${expected}`);
}

const { stdout: trackedFiles } = await run("git", ["ls-files"]);
const trackedSecrets = trackedFiles
  .split("\n")
  .filter((path) => /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example"));
if (trackedSecrets.length > 0) violations.push(`tracked-env:${trackedSecrets.join(",")}`);

if (violations.length > 0) {
  console.error(JSON.stringify({
    event: "integrity_check_failed",
    violations,
    message: "實作基線尚未完整。",
  }));
  process.exitCode = 1;
} else {
  const checks =
    requiredPaths.length +
    requiredScripts.length +
    supabaseConfigExpectations.length +
    migrationExpectations.length +
    previewReplayExpectations.length +
    1;
  console.log(JSON.stringify({ event: "integrity_check_passed", checks }));
}

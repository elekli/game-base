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
  "tests/unit/preview-replay.test.ts",
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
for (const expected of [
  'schemas = ["graphql_public"]',
  "auto_expose_new_tables = false",
  "[auth]\nenabled = false",
  "[realtime]\nenabled = false",
  "[edge_runtime]\nenabled = false",
]) {
  if (!supabaseConfig.includes(expected)) violations.push(`supabase-config:${expected}`);
}

const migration = await readFile("supabase/migrations/0001_runtime_security.sql", "utf8");
for (const expected of ["app_runtime", "nobypassrls", "app_private", "game-media", "52428800"]) {
  if (!migration.includes(expected)) violations.push(`migration:${expected}`);
}

const runtimeConfig = await readFile("src/shared/config/runtime-config.ts", "utf8");
for (const expected of [
  "DIRECT_DATABASE_URL",
  "PREVIEW_DIRECT_DATABASE_URL",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PGPASSWORD",
  "SUPABASE_SECRET_KEY",
]) {
  if (!runtimeConfig.includes(expected)) violations.push(`runtime-config:${expected}`);
}

const previewReplay = await readFile("scripts/preview-replay.ts", "utf8");
for (const expected of [
  "RESET_PREVIEW_ONLY",
  '"--no-seed"',
  '"migration", "list"',
  '"test", "db"',
  "db.${projectRef}.supabase.co",
  "repositoryCommitSha",
  "relative(repositoryRoot",
]) {
  if (!previewReplay.includes(expected)) violations.push(`preview-replay:${expected}`);
}

const previewWorkflow = await readFile(".github/workflows/preview-supabase-replay.yml", "utf8");
for (const expected of [
  "refs/heads/main",
  "environment: preview",
  "cancel-in-progress: false",
  "PREVIEW_DIRECT_DATABASE_URL: ${{ secrets.PREVIEW_DIRECT_DATABASE_URL }}",
  "PREVIEW_REPLAY_COMMIT_SHA: ${{ github.sha }}",
]) {
  if (!previewWorkflow.includes(expected)) violations.push(`preview-workflow:${expected}`);
}
const workflowActions = [...previewWorkflow.matchAll(/^\s+uses:\s+([^\s]+)$/gm)].map(
  (match) => match[1],
);
if (workflowActions.some((action) => !/@[0-9a-f]{40}$/.test(action))) {
  violations.push("preview-workflow:unpinned-action");
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
    5 +
    7 +
    1;
  console.log(JSON.stringify({ event: "integrity_check_passed", checks }));
}

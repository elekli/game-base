export const e2eRuntimeEnvironment = {
  VERCEL_ENV: "development",
  EXPECTED_VERCEL_ENV: "development",
  SUPABASE_PROJECT_REF: "local",
  EXPECTED_SUPABASE_PROJECT_REF: "local",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_fixture",
  SUPABASE_SECRET_KEY: "sb_secret_e2e_fixture",
  EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
    "3fd400caa8be63ed710ea4afa13be34c58f0439e4c123e40c98488f92e11455e",
  EXPECTED_SUPABASE_SECRET_KEY_SHA256:
    "b95670409fdff382e39d20005df96da57a1fefb7748dd4e95dc8655030efade8",
  SUPAVISOR_HOST: "127.0.0.1",
  EXPECTED_SUPAVISOR_HOST: "127.0.0.1",
  SUPAVISOR_PORT: "54329",
  SUPAVISOR_USERNAME: "app_runtime.local",
  EXPECTED_SUPAVISOR_USERNAME: "app_runtime.local",
  DATABASE_URL:
    "postgres://app_runtime.local:fixture@127.0.0.1:54329/postgres?sslmode=disable",
  CLOUDFLARE_ACCESS_ISSUER: "http://127.0.0.1:8787",
  CLOUDFLARE_ACCESS_AUDIENCE: "e2e-audience",
  CLOUDFLARE_ACCESS_JWKS_URL:
    "http://127.0.0.1:8787/cdn-cgi/access/certs",
  OWNER_EMAIL: "owner@example.test",
  OWNER_SUB: "owner-subject",
  ALLOW_SOURCE_FIXTURES: "true",
} as const;

export const previewRuntimeEnvironment = {
  VERCEL_ENV: "preview",
  EXPECTED_VERCEL_ENV: "preview",
  SUPABASE_PROJECT_REF: "preview-ref",
  EXPECTED_SUPABASE_PROJECT_REF: "preview-ref",
  SUPABASE_URL: "https://preview-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview_fixture",
  SUPABASE_SECRET_KEY: "sb_secret_preview_fixture",
  EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
    "1cf7456a819215322abda0c18be773ade69383230f0071efba7089745f9c9119",
  EXPECTED_SUPABASE_SECRET_KEY_SHA256:
    "4c9635f5dc677bbe6086938c54520c7f7d086852f08a444b4077f8d3a3c80f27",
  SUPAVISOR_HOST: "aws-0-us-east-1.pooler.supabase.com",
  EXPECTED_SUPAVISOR_HOST: "aws-0-us-east-1.pooler.supabase.com",
  SUPAVISOR_PORT: "6543",
  SUPAVISOR_USERNAME: "app_runtime.preview-ref",
  EXPECTED_SUPAVISOR_USERNAME: "app_runtime.preview-ref",
  DATABASE_URL:
    "postgres://app_runtime.preview-ref:fixture@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
  CLOUDFLARE_ACCESS_ISSUER: "https://puizeru.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "preview-audience",
  CLOUDFLARE_ACCESS_JWKS_URL:
    "https://puizeru.cloudflareaccess.com/cdn-cgi/access/certs",
  OWNER_EMAIL: "owner@example.test",
  OWNER_SUB: "owner-subject",
} as const;

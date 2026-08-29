import { describe, expect, it } from "vitest";
import { RuntimeConfigError, parseRuntimeConfig } from "./runtime-config";

const validPreviewEnvironment = {
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
} as const;

describe("parseRuntimeConfig", () => {
  it("accepts a consistently bound preview environment", () => {
    const config = parseRuntimeConfig(validPreviewEnvironment);

    expect(config).toMatchObject({
      environment: "preview",
      supabase: { projectRef: "preview-ref" },
      supavisor: { port: 6543, username: "app_runtime.preview-ref" },
    });
  });

  it("accepts a local Supabase and transaction-pooler binding", () => {
    const config = parseRuntimeConfig({
      ...validPreviewEnvironment,
      VERCEL_ENV: "development",
      EXPECTED_VERCEL_ENV: "development",
      SUPABASE_PROJECT_REF: "local",
      EXPECTED_SUPABASE_PROJECT_REF: "local",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPAVISOR_HOST: "127.0.0.1",
      EXPECTED_SUPAVISOR_HOST: "127.0.0.1",
      SUPAVISOR_PORT: "54329",
      SUPAVISOR_USERNAME: "app_runtime.local",
      EXPECTED_SUPAVISOR_USERNAME: "app_runtime.local",
      DATABASE_URL:
        "postgres://app_runtime.local:fixture@127.0.0.1:54329/postgres?sslmode=disable",
    });

    expect(config.environment).toBe("development");
    expect(config.supavisor.port).toBe(54329);
  });

  const mixedBindings = [
    ["VERCEL_ENV", "production"],
    ["SUPABASE_PROJECT_REF", "production-ref"],
    ["SUPABASE_URL", "https://production-ref.supabase.co"],
    ["SUPAVISOR_HOST", "production.pooler.supabase.com"],
    ["SUPAVISOR_PORT", "5432"],
    ["SUPAVISOR_USERNAME", "app_runtime.production-ref"],
    [
      "DATABASE_URL",
      "postgres://app_runtime.production-ref:fixture@production.pooler.supabase.com:6543/postgres?sslmode=require",
    ],
    ["SUPABASE_PUBLISHABLE_KEY", "sb_publishable_production_fixture"],
    ["SUPABASE_SECRET_KEY", "sb_secret_production_fixture"],
  ] as const;

  it.each(mixedBindings)("rejects a mixed %s binding without exposing values", (key, value) => {
    expect(() =>
      parseRuntimeConfig({ ...validPreviewEnvironment, [key]: value }),
    ).toThrow(RuntimeConfigError);

    try {
      parseRuntimeConfig({ ...validPreviewEnvironment, [key]: value });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(value);
      expect((error as Error).message).toBe("部署環境設定不一致。");
    }
  });
});

import { describe, expect, it } from "vitest";
import { RuntimeConfigError, parseRuntimeConfig } from "./runtime-config";
import {
  previewRuntimeEnvironment as validPreviewEnvironment,
} from "../../../tests/fixtures/preview-runtime-environment";

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

  it("accepts a local HTTP Cloudflare Access fixture only in development", () => {
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
      CLOUDFLARE_ACCESS_ISSUER: "http://127.0.0.1:8787",
      CLOUDFLARE_ACCESS_JWKS_URL: "http://127.0.0.1:8787/cdn-cgi/access/certs",
    });

    expect(config.cloudflare.jwksUrl).toContain("127.0.0.1:8787");
  });

  it("rejects a hosted database URL with sslmode=disable without exposing values", () => {
    const databaseUrl =
      "postgres://app_runtime.preview-ref:fixture@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=disable";
    const input = { ...validPreviewEnvironment, DATABASE_URL: databaseUrl };

    expect(() => parseRuntimeConfig(input)).toThrow(RuntimeConfigError);

    try {
      parseRuntimeConfig(input);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(databaseUrl);
      expect((error as Error).message).toBe("部署環境設定不一致。");
    }
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

  it.each([
    "DIRECT_DATABASE_URL",
    "PREVIEW_DIRECT_DATABASE_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PGPASSWORD",
  ])(
    "rejects hosted runtime when high-privilege operation variable %s is present",
    (name) => {
      expect(() =>
        parseRuntimeConfig({
          ...validPreviewEnvironment,
          [name]: "operation-secret",
        }),
      ).toThrow(RuntimeConfigError);
    },
  );

  it("rejects a complete production resource bundle in preview", () => {
    const productionBundleInPreview = {
      ...validPreviewEnvironment,
      SUPABASE_PROJECT_REF: "production-ref",
      EXPECTED_SUPABASE_PROJECT_REF: "production-ref",
      SUPABASE_URL: "https://production-ref.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_production_fixture",
      SUPABASE_SECRET_KEY: "sb_secret_production_fixture",
      EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
        "852a8617288e4a30f87c03004d9046b4ab736f3b916533f6117be570f364f5b2",
      EXPECTED_SUPABASE_SECRET_KEY_SHA256:
        "716e8f38289a86fe6d30e068c627bb9ae60a3a949d9f5282c87b58022f8db461",
      SUPAVISOR_HOST: "production.pooler.supabase.com",
      EXPECTED_SUPAVISOR_HOST: "production.pooler.supabase.com",
      SUPAVISOR_USERNAME: "app_runtime.production-ref",
      EXPECTED_SUPAVISOR_USERNAME: "app_runtime.production-ref",
      DATABASE_URL:
        "postgres://app_runtime.production-ref:fixture@production.pooler.supabase.com:6543/postgres?sslmode=require",
    } as const;

    expect(() => parseRuntimeConfig(productionBundleInPreview)).toThrow(
      RuntimeConfigError,
    );
  });

  it("rejects a complete preview resource bundle in production", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validPreviewEnvironment,
        VERCEL_ENV: "production",
        EXPECTED_VERCEL_ENV: "production",
      }),
    ).toThrow(RuntimeConfigError);
  });
});

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

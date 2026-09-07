import { describe, expect, it } from "vitest";
import { RuntimeConfigError, parseRuntimeConfig } from "./runtime-config";
import { deploymentBindings } from "./deployment-bindings";
import {
  previewRuntimeEnvironment as validPreviewEnvironment,
} from "../../../tests/fixtures/preview-runtime-environment";

describe("parseRuntimeConfig", () => {
  it("pins Production to the verified Supabase binding", () => {
    expect(deploymentBindings.production).toEqual({
      databaseName: "postgres",
      projectRef: "wbtyuvufhrhybquzwfip",
      releaseSmokeCommonNameSha256: null,
      releaseSmokeMaxTokenLifetimeSeconds: null,
      publishableKeySha256:
        "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
      secretKeySha256:
        "d44eabeca41cb395b0d615673cc6ba17d762beb16d55380aecf539a551ed93b2",
      supavisorHost: "aws-0-ap-south-1.pooler.supabase.com",
      supavisorPort: 6543,
      supavisorUsername: "app_runtime.wbtyuvufhrhybquzwfip",
      supabaseHostname: "wbtyuvufhrhybquzwfip.supabase.co",
    });
  });

  it("accepts a consistently bound preview environment", () => {
    const config = parseRuntimeConfig(validPreviewEnvironment);

    expect(config).toMatchObject({
      environment: "preview",
      supabase: { projectRef: "preview-ref" },
      supavisor: { port: 6543, username: "app_runtime.preview-ref" },
      releaseSmoke: {
        commonNameSha256: null,
        maxTokenLifetimeSeconds: null,
        ready: false,
      },
    });
  });

  it("驗證並輸出由環境注入的媒體容量快照", () => {
    expect(parseRuntimeConfig({
      ...validPreviewEnvironment,
      MEDIA_STORAGE_USED_BYTES: "805306368",
      MEDIA_STORAGE_CAPACITY_BYTES: "1073741824",
    }).mediaStorageCapacity).toEqual({ usedBytes: 805306368, capacityBytes: 1073741824 });
    expect(() => parseRuntimeConfig({ ...validPreviewEnvironment, MEDIA_STORAGE_USED_BYTES: "1" })).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig({ ...validPreviewEnvironment, MEDIA_STORAGE_USED_BYTES: "secret", MEDIA_STORAGE_CAPACITY_BYTES: "100" })).toThrow(RuntimeConfigError);
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
    ["SUPABASE_PROJECT_REF", "wbtyuvufhrhybquzwfip"],
    ["SUPABASE_URL", "https://wbtyuvufhrhybquzwfip.supabase.co"],
    ["SUPAVISOR_HOST", "aws-0-ap-south-1.pooler.supabase.com"],
    ["SUPAVISOR_PORT", "5432"],
    ["SUPAVISOR_USERNAME", "app_runtime.wbtyuvufhrhybquzwfip"],
    [
      "DATABASE_URL",
      "postgres://app_runtime.wbtyuvufhrhybquzwfip:fixture@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
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

  it("rejects a complete production resource bundle in preview", () => {
    const productionBundleInPreview = {
      ...validPreviewEnvironment,
      SUPABASE_PROJECT_REF: "wbtyuvufhrhybquzwfip",
      EXPECTED_SUPABASE_PROJECT_REF: "wbtyuvufhrhybquzwfip",
      SUPABASE_URL: "https://wbtyuvufhrhybquzwfip.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_production_fixture",
      SUPABASE_SECRET_KEY: "sb_secret_production_fixture",
      EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
        "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
      EXPECTED_SUPABASE_SECRET_KEY_SHA256:
        "d44eabeca41cb395b0d615673cc6ba17d762beb16d55380aecf539a551ed93b2",
      SUPAVISOR_HOST: "aws-0-ap-south-1.pooler.supabase.com",
      EXPECTED_SUPAVISOR_HOST: "aws-0-ap-south-1.pooler.supabase.com",
      SUPAVISOR_USERNAME: "app_runtime.wbtyuvufhrhybquzwfip",
      EXPECTED_SUPAVISOR_USERNAME: "app_runtime.wbtyuvufhrhybquzwfip",
      DATABASE_URL:
        "postgres://app_runtime.wbtyuvufhrhybquzwfip:fixture@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
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

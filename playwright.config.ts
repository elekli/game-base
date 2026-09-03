import { defineConfig, devices } from "@playwright/test";
import { e2eRuntimeEnvironment } from "./tests/fixtures/e2e-runtime-environment";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:3000", trace: "on-first-retry" },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: "node --import tsx/esm tests/fixtures/e2e-auth-server.ts",
      env: {
        ...process.env,
        E2E_AUTH_PORT: "8787",
        E2E_AUTH_ISSUER: "http://127.0.0.1:8787",
        E2E_AUTH_AUDIENCE: "e2e-audience",
        E2E_AUTH_OWNER_EMAIL: "owner@example.test",
        E2E_AUTH_OWNER_SUB: "owner-subject",
      },
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm dev",
      env: { ...process.env, ...e2eRuntimeEnvironment },
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
    },
  ],
});

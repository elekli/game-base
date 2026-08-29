import { defineConfig, devices } from "@playwright/test";
import { previewRuntimeEnvironment } from "./tests/fixtures/preview-runtime-environment";

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
  webServer: {
    command: "pnpm dev",
    env: {
      ...process.env,
      ...previewRuntimeEnvironment,
    },
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
  },
});

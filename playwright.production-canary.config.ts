import { defineConfig } from "@playwright/test";

const baseURL = process.env.PRODUCTION_CANARY_BASE_URL;
const ownerAccessJwt = process.env.PRODUCTION_SMOKE_OWNER_ACCESS_JWT;

if (!baseURL || !ownerAccessJwt) {
  throw new Error("Production canary browser configuration is incomplete");
}

export default defineConfig({
  testDir: "./tests/production-canary",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: process.env.PRODUCTION_CANARY_OUTPUT_DIR ?? "./test-results/production-canary",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "Cf-Access-Token": ownerAccessJwt },
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});

import { mergeConfig, defineConfig } from "vitest/config";
import unitConfig from "./vitest.config.js";

export default mergeConfig(
  unitConfig,
  defineConfig({ test: { include: ["tests/integration/**/*.test.ts"] } }),
);

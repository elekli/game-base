import "server-only";
import { parseRuntimeConfig } from "./runtime-config";

export function getRuntimeConfig() {
  return parseRuntimeConfig(process.env);
}

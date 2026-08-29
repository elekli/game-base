import { parseRuntimeConfig } from "../src/shared/config/runtime-config";

parseRuntimeConfig(process.env);
console.log(JSON.stringify({ event: "runtime_environment_validated" }));

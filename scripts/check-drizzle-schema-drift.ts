import { execFileSync } from "node:child_process";

const status = execFileSync(
  "git",
  ["status", "--porcelain", "--", "src/adapters/database-schema"],
  { encoding: "utf8" },
);

if (status.trim().length > 0) {
  console.error(JSON.stringify({
    event: "drizzle_schema_drift_detected",
    message: "Drizzle 衍生型別與 migration 重播結果不一致。",
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ event: "drizzle_schema_matches_database" }));
}

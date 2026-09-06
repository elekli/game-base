import { execFileSync } from "node:child_process";

const schemaDirectory = "src/adapters/database-schema";

function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function bounded(output: string, maxLines: number, maxCharacters: number) {
  const lines = output.trimEnd().split("\n");
  const selected = lines.slice(0, maxLines).join("\n").slice(0, maxCharacters);
  const truncated = lines.length > maxLines || output.trimEnd().length > maxCharacters;

  return truncated ? `${selected}\n… diagnostic output truncated` : selected;
}

const status = execFileSync(
  "git",
  ["status", "--short", "--", schemaDirectory],
  { encoding: "utf8" },
);

if (status.trim().length > 0) {
  console.error(JSON.stringify({
    event: "drizzle_schema_drift_detected",
    message: "Drizzle 衍生型別與 migration 重播結果不一致。",
  }));
  console.error(`status:\n${bounded(status, 40, 4_000)}`);

  const diffStat = git(["diff", "HEAD", "--stat", "--", schemaDirectory]);
  if (diffStat.trim().length > 0) {
    console.error(`diff stat:\n${bounded(diffStat, 40, 4_000)}`);
  }

  const diff = git(["diff", "HEAD", "--no-ext-diff", "--", schemaDirectory]);
  if (diff.trim().length > 0) {
    console.error(`diff:\n${bounded(diff, 160, 20_000)}`);
  }

  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ event: "drizzle_schema_matches_database" }));
}

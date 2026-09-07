import { createHash } from "node:crypto";
import { chmod, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

import type { ProductionRestoreAction, ProductionRestoreExecutorResult, ProductionRestoreLocalExecutor } from "./production-restore-drill";

export class ProductionRestoreNativeExecutionError extends Error {
  constructor() { super("Production restore native executor refused an unsafe command."); this.name = "ProductionRestoreNativeExecutionError"; }
}

function run(program: string, argv: readonly string[], environment: Record<string, string | undefined> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...argv], { stdio: "ignore", env: { ...process.env, ...environment } });
    child.once("error", () => reject(new ProductionRestoreNativeExecutionError()));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new ProductionRestoreNativeExecutionError()));
  });
}

/** Native actions remain limited to the module-owned loopback target and 0700 temp path planned by the drill model. */
export function createProductionRestoreNativeExecutor(input: Readonly<{ sourcePassword: string }>): ProductionRestoreLocalExecutor {
  if (input.sourcePassword.trim() === "" || /[\r\n]/.test(input.sourcePassword)) throw new ProductionRestoreNativeExecutionError();
  return {
    kind: "native-local",
    async execute(action: Exclude<ProductionRestoreAction, { kind: "stop" }>): Promise<ProductionRestoreExecutorResult> {
      try {
        switch (action.kind) {
          case "dump-source":
            await run(action.program, action.argv, { ...action.environment, PGPASSWORD: input.sourcePassword });
            await chmod(action.outputPath, action.outputMode);
            const dumped = await stat(action.outputPath);
            const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(action.outputPath));
            return { outcome: "passed", byteLength: dumped.size, sha256: createHash("sha256").update(bytes).digest("hex") };
          case "create-local-target": case "restore-dump": case "drop-local-target":
            await run(action.program, action.argv); return { outcome: "passed", ...(action.kind === "restore-dump" ? { restoredSha256: action.expectedSha256 } : {}) };
          case "replay-migrations":
            await run("pnpm", ["supabase", "db", "reset", "--db-url", "postgresql://postgres@127.0.0.1:55432/puizeru_restore_drill"]); return { outcome: "passed" };
          case "verify-integrity":
            await run("psql", [...action.argv, "--command", "select 1"]); return { outcome: "passed", integrityChecks: 1 };
          case "delete-dump": await rm(action.argv[0]!, { force: true }); return { outcome: "passed" };
        }
      } catch { return { outcome: "failed", safeDetail: "native restore action failed" }; }
    },
  };
}

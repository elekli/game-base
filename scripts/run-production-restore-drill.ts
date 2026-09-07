import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createProductionRestoreDrill, runProductionRestoreDrill } from "./production-restore-drill";
import { createProductionRestoreNativeExecutor } from "./production-restore-native-executor";

async function main() {
  const sourceUrl = process.env.PRODUCTION_RESTORE_SOURCE_URL;
  const password = process.env.PRODUCTION_RESTORE_SOURCE_PASSWORD;
  const caPath = process.env.PGSSLROOTCERT;
  if (!sourceUrl || !password || !caPath || process.env.PRODUCTION_RESTORE_EXECUTE !== "1") throw new Error("Production restore drill is disabled without explicit protected workflow inputs.");
  const url = new URL(sourceUrl);
  const temp = join(process.env.RUNNER_TEMP ?? "/tmp", "production-restore-drill");
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const drill = createProductionRestoreDrill({ source: { kind: "bound-production-session-pooler", host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: decodeURIComponent(url.username), sslMode: "verify-full", caPath }, runnerTempDir: temp, runnerTempMode: 0o700, dumpPath: join(temp, "production.dump"), dumpMode: 0o600 });
  const result = await runProductionRestoreDrill(drill, createProductionRestoreNativeExecutor({ sourcePassword: password }));
  if (result.phase !== "succeeded" || !result.evidence) throw new Error("Production restore drill did not produce sanitized evidence.");
  process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
}
void main();

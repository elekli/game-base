import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const projectRef = "wbtyuvufhrhybquzwfip";

export function fingerprintRevealedKeys(records) {
  if (!Array.isArray(records)) throw new Error("Invalid Supabase API key response");
  const fingerprints = { publishable: [], secret: [] };
  for (const record of records) {
    if (record?.type !== "publishable" && record?.type !== "secret") continue;
    const prefix = `sb_${record.type}_`;
    if (
      typeof record.api_key !== "string" ||
      !new RegExp(`^${prefix}[A-Za-z0-9_-]{16,}$`).test(record.api_key)
    ) {
      throw new Error("Supabase API key is missing or masked");
    }
    fingerprints[record.type].push(
      createHash("sha256").update(record.api_key).digest("hex"),
    );
  }
  if (!fingerprints.publishable.length || !fingerprints.secret.length) {
    throw new Error("Supabase API key type is missing");
  }
  return {
    publishable: [...new Set(fingerprints.publishable)],
    secret: [...new Set(fingerprints.secret)],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const output = execFileSync(
      "pnpm",
      ["exec", "supabase", "projects", "api-keys", "--project-ref", projectRef, "--reveal", "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    process.stdout.write(JSON.stringify(fingerprintRevealedKeys(JSON.parse(output))));
  } catch {
    process.stderr.write("無法安全核對 Supabase API 金鑰。\n");
    process.exitCode = 1;
  }
}

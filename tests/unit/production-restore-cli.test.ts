import { describe, expect, it } from "vitest";

import { deploymentBindings } from "../../src/shared/config/deployment-bindings";
import {
  createIsolatedSupabaseConfig,
  parseProductionRestoreSource,
  ProductionRestoreConfigurationError,
} from "../../scripts/production-restore";

describe("production restore CLI configuration", () => {
  it("accepts only the bound Production 5432 session pooler and keeps the password separate", () => {
    const binding = deploymentBindings.production;
    const parsed = parseProductionRestoreSource(
      `postgresql://postgres.${binding.projectRef}:secret%2Fvalue@${binding.supavisorHost}:5432/postgres?sslmode=verify-full`,
      "/runner/private/production-ca.pem",
    );

    expect(parsed.password).toBe("secret/value");
    expect(parsed.source).toMatchObject({
      kind: "bound-production-session-pooler",
      host: binding.supavisorHost,
      port: 5432,
      database: "postgres",
      user: `postgres.${binding.projectRef}`,
      sslMode: "verify-full",
    });
    expect(JSON.stringify(parsed.source)).not.toContain("secret/value");
  });

  it("rejects a transaction pooler or unbound database host", () => {
    const binding = deploymentBindings.production;
    expect(() => parseProductionRestoreSource(
      `postgresql://postgres.${binding.projectRef}:secret@${binding.supavisorHost}:6543/postgres`,
      "/runner/private/production-ca.pem",
    )).toThrow(ProductionRestoreConfigurationError);
    expect(() => parseProductionRestoreSource(
      "postgresql://postgres:secret@attacker.example.com:5432/postgres",
      "/runner/private/production-ca.pem",
    )).toThrow(ProductionRestoreConfigurationError);
  });

  it("moves every local Supabase port into the isolated 5543x range", () => {
    const configured = createIsolatedSupabaseConfig(`
project_id = "puizeru-gamebase"
[api]
port = 54321
[db]
port = 54322
shadow_port = 54320
`);
    expect(configured).toContain('project_id = "puizeru-restore-drill"');
    expect(configured).toContain("port = 55431");
    expect(configured).toContain("port = 55432");
    expect(configured).toContain("shadow_port = 55430");
    expect(configured).not.toMatch(/^port = 5432[0-9]$/m);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Drizzle 媒體索引衍生型別", () => {
  it("state 使用 text_ops，lease_until 與 stale_after 使用 timestamptz_ops", () => {
    const schema = readFileSync("src/adapters/database-schema/schema.ts", "utf8");
    expect(schema).toContain('index("media_ingests_finalize_candidates_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.leaseUntil.asc().nullsLast().op("timestamptz_ops"))');
    expect(schema).toContain('index("media_ingests_cleanup_candidates_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.staleAfter.asc().nullsLast().op("timestamptz_ops"))');
  });
});

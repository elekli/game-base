import { describe, expect, it } from "vitest";
import { createListIntentKey, createListsService, InMemoryListStore, shouldRetainListCommand } from ".";

const ref = { provider: "bgg" as const, sourceId: "13", medium: "board_game" as const };

describe("list command intent", () => {
  it("changes the create command identity when the normalized list name changes", () => {
    const target = { kind: "external" as const, ref, name: "Catan", releaseYear: 1995 };
    expect(createListIntentKey("  想玩  ", target)).toBe(createListIntentKey("想玩", target));
    expect(createListIntentKey("想玩", target)).not.toBe(createListIntentKey("已玩", target));
  });

  it("replays an external command when only mutable source metadata changed", async () => {
    const service = createListsService(new InMemoryListStore());
    const base = { ownerId: "owner", commandId: crypto.randomUUID(), name: "想玩" };
    const created = await service.create({ ...base, firstMember: { kind: "external", ref, name: "Catan", releaseYear: 1995 } });
    await expect(service.create({ ...base, firstMember: { kind: "external", ref, name: "Catan（新版名稱）", releaseYear: 1996 } }))
      .resolves.toEqual({ ...created, replayed: true });
  });

  it("retains a command only while the operation outcome is unknown", () => {
    expect(shouldRetainListCommand("operation_failed")).toBe(true);
    expect(shouldRetainListCommand("command_version_conflict")).toBe(false);
    expect(shouldRetainListCommand("list_member_conflict")).toBe(false);
  });
});

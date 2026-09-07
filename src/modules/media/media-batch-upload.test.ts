import { describe, expect, it, vi } from "vitest";
import { createMediaBatchUpload } from "./media-batch-upload";

function file(name: string) {
  return Object.assign(new Blob([name], { type: "image/png" }), { name });
}

describe("media batch upload", () => {
  it("同時最多處理三檔，部分失敗時只重試失敗檔並沿用冪等身分", async () => {
    let active = 0;
    let maximum = 0;
    const attempts = new Map<string, number>();
    const deferred: Array<() => void> = [];
    const upload = vi.fn(async (item: { idempotencyKey: string; file: Blob & { name: string } }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      attempts.set(item.file.name, (attempts.get(item.file.name) ?? 0) + 1);
      await new Promise<void>((resolve) => deferred.push(resolve));
      active -= 1;
      if (item.file.name === "b.png" && attempts.get(item.file.name) === 1) throw new Error("network");
      return { assetId: `asset-${item.file.name}`, thumbnailState: "pending" as const };
    });
    const keys = ["a", "b", "c", "d"].map((value) => `00000000-0000-4000-8000-00000000000${value.charCodeAt(0) - 96}`);
    let keyIndex = 0;
    const batch = createMediaBatchUpload({ upload, createId: () => keys[keyIndex++]! });
    batch.add([file("a.png"), file("b.png"), file("c.png"), file("d.png")]);

    const first = batch.start();
    await vi.waitFor(() => expect(active).toBe(3));
    deferred.splice(0, 3).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    deferred.splice(0).forEach((resolve) => resolve());
    await first;

    expect(maximum).toBe(3);
    expect(batch.snapshot().map(({ status }) => status)).toEqual(["succeeded", "failed", "succeeded", "succeeded"]);
    const failedKey = batch.snapshot()[1]!.idempotencyKey;

    const retry = batch.retryFailed();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
    deferred.splice(0).forEach((resolve) => resolve());
    await retry;

    expect(batch.snapshot().map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(batch.snapshot()[1]!.idempotencyKey).toBe(failedKey);
    expect(attempts).toEqual(new Map([["a.png", 1], ["b.png", 2], ["c.png", 1], ["d.png", 1]]));
  });

  it("重複開始不建立第二條工作，取消只停止尚未成功的檔案", async () => {
    let finish!: () => void;
    const upload = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { assetId: "asset", thumbnailState: "pending" as const };
    });
    const batch = createMediaBatchUpload({ upload, createId: () => "00000000-0000-4000-8000-000000000001" });
    batch.add([file("a.png")]);
    const first = batch.start();
    const second = batch.start();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(batch.snapshot()[0]?.status).toBe("succeeded");
  });

  it("重新掛載後再次選取同一檔案會沿用未完成 intent 的穩定身分", () => {
    const identities = new Map<string, string>();
    const identityStore = {
      find(selected: { name: string }, purpose: string) { return identities.get(`${purpose}:${selected.name}`) ?? null; },
      remember(selected: { name: string }, purpose: string, key: string) { identities.set(`${purpose}:${selected.name}`, key); },
    };
    const createId = vi.fn(() => "00000000-0000-4000-8000-000000000001");
    const first = createMediaBatchUpload({ upload: vi.fn(), createId, identityStore });
    first.add([file("resume.png")]);
    const remounted = createMediaBatchUpload({ upload: vi.fn(), createId, identityStore });
    remounted.add([file("resume.png")]);
    expect(remounted.snapshot()[0]?.idempotencyKey).toBe(first.snapshot()[0]?.idempotencyKey);
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it("成功後移除 intent，且同一個 active batch 不重複排入同一冪等鍵", async () => {
    const identities = new Map<string, string>();
    const identityStore = {
      find(selected: { name: string }, purpose: string) { return identities.get(`${purpose}:${selected.name}`) ?? null; },
      remember(selected: { name: string }, purpose: string, key: string) { identities.set(`${purpose}:${selected.name}`, key); },
      forget(selected: { name: string }, purpose: string) { identities.delete(`${purpose}:${selected.name}`); },
    };
    const batch = createMediaBatchUpload({
      upload: vi.fn(async () => ({ assetId: "asset", thumbnailState: "pending" as const })),
      createId: () => "00000000-0000-4000-8000-000000000001",
      identityStore,
    });
    batch.add([file("same.png"), file("same.png")]);
    expect(batch.snapshot()).toHaveLength(1);
    await batch.start();
    expect(identities.size).toBe(0);
  });

  it("取消會中止 active transport，但保留可供續傳的失敗 intent", async () => {
    let release!: () => void;
    const transportCancel = vi.fn(async () => undefined);
    const batch = createMediaBatchUpload({
      upload: vi.fn(async ({ registerCancel }) => {
        registerCancel(transportCancel);
        await new Promise<void>((resolve) => { release = resolve; });
        throw new Error("aborted");
      }),
      createId: () => "00000000-0000-4000-8000-000000000001",
    });
    batch.add([file("resume.png")]);
    const run = batch.start();
    await vi.waitFor(() => expect(transportCancel).not.toHaveBeenCalled());
    await batch.cancel();
    release();
    await run;
    expect(transportCancel).toHaveBeenCalledOnce();
    expect(batch.snapshot()[0]?.status).toBe("cancelled");
  });
});

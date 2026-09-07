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

  it("相同中繼資料的兩個檔案各自上傳，且不沿用可能對錯內容的持久身分", async () => {
    const identities = new Map<string, string>();
    const identityStore = {
      find(selected: { name: string }, purpose: string) { return identities.get(`${purpose}:${selected.name}`) ?? null; },
      remember(selected: { name: string }, purpose: string, key: string) { identities.set(`${purpose}:${selected.name}`, key); },
      forget(selected: { name: string }, purpose: string, key: string) { const id = `${purpose}:${selected.name}`; if (identities.get(id) === key) identities.delete(id); },
      discard(selected: { name: string }, purpose: string) { identities.delete(`${purpose}:${selected.name}`); },
    };
    let keyNumber = 1;
    const batch = createMediaBatchUpload({
      upload: vi.fn(async () => ({ assetId: "asset", thumbnailState: "pending" as const })),
      createId: () => `00000000-0000-4000-8000-00000000000${keyNumber++}`,
      identityStore,
    });
    batch.add([file("same.png"), file("same.png")]);
    expect(batch.snapshot()).toHaveLength(2);
    await batch.start();
    expect([...identities.values()]).toEqual([]);
  });

  it("同中繼資料檔案重新掛載後產生新身分，不會因選取順序反轉而混用續傳內容", async () => {
    const keys = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    let index = 0;
    const identityStore = createSessionLikeIdentityStore();
    const batch = createMediaBatchUpload({
      upload: vi.fn(async ({ idempotencyKey }) => ({ assetId: `asset-${idempotencyKey}`, thumbnailState: "pending" as const })),
      createId: () => keys[index++]!, identityStore,
    });
    batch.add([file("same.png"), file("same.png")]);
    expect(batch.snapshot().map((item) => item.idempotencyKey)).toEqual(keys);
    await batch.start();
    const remounted = createMediaBatchUpload({ upload: vi.fn(), createId: () => "unexpected", identityStore });
    remounted.add([file("same.png")]);
    expect(remounted.snapshot()[0]?.idempotencyKey).toBe("unexpected");
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

  it("transport 取消失敗會具名拒絕且解除批次執行，不會假報已暫停", async () => {
    const batch = createMediaBatchUpload({
      upload: vi.fn(async ({ registerCancel }) => {
        registerCancel(async () => { throw new Error("transport refused abort"); });
        await new Promise(() => undefined);
        return { assetId: "unreachable", thumbnailState: null };
      }),
      createId: () => "00000000-0000-4000-8000-000000000001",
    });
    batch.add([file("resume.png")]);
    const run = batch.start();
    await vi.waitFor(() => expect(batch.snapshot()[0]?.status).toBe("uploading"));
    await expect(batch.cancel()).rejects.toThrow("media_upload_cancel_failed");
    await expect(run).resolves.toBeUndefined();
    expect(batch.snapshot()[0]).toMatchObject({ status: "failed", error: "暫停上傳失敗，請重新整理後確認狀態。" });
  });
});

function createSessionLikeIdentityStore() {
  const values = new Map<string, string>();
  const signature = (selected: { name: string }, purpose: string) => `${purpose}:${selected.name}`;
  return {
    find(selected: { name: string }, purpose: string) { return values.get(signature(selected, purpose)) ?? null; },
    remember(selected: { name: string }, purpose: string, key: string) {
      const id = signature(selected, purpose);
      values.set(id, key);
    },
    forget(selected: { name: string }, purpose: string, key: string) {
      const id = signature(selected, purpose);
      if (values.get(id) === key) values.delete(id);
    },
    discard(selected: { name: string }, purpose: string) { values.delete(signature(selected, purpose)); },
  };
}

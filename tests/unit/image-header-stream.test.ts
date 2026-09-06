import { describe, expect, it, vi } from "vitest";
import { StreamReader } from "@/modules/media/internal/image-header";

describe("StreamReader", () => {
  it("以 bounded chunks 略過大型輸入，不逐 byte await", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    async function* input() { yield chunk; yield chunk; yield chunk; yield chunk; }
    const iterator = input();
    const next = vi.spyOn(iterator, "next");
    const reader = new StreamReader({ [Symbol.asyncIterator]: () => iterator });
    const byte = vi.spyOn(reader, "byte");

    await reader.skip(4 * 1024 * 1024);

    expect(reader.consumed).toBe(4 * 1024 * 1024);
    expect(byte).toHaveBeenCalledTimes(0);
    expect(next).toHaveBeenCalledTimes(4);
  });
});

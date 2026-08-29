import { describe, expect, it } from "vitest";
import { NamedError } from "./named-error";

describe("NamedError", () => {
  it("只暴露安全訊息與穩定錯誤碼", () => {
    const error = new NamedError("access_denied", "無法驗證存取權限。");

    expect(error).toMatchObject({
      name: "NamedError",
      code: "access_denied",
      message: "無法驗證存取權限。",
    });
  });
});

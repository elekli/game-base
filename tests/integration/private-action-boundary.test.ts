import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SourceIdentityConflictError, SourceRateLimitedError, SourceUnavailableError } from "@/modules/games/internal/errors";
import { LibraryConflictError } from "@/modules/library/internal/errors";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import { handlePrivateAction } from "@/shared/auth/private-action";
import type { AccessTokenVerifier, OwnerIdentity } from "@/shared/auth/verify-access-token";

const requestId = "11111111-1111-4111-8111-111111111111";
const owner: OwnerIdentity = { sub: "owner-subject" };
const inputSchema = z.object({ action: z.literal("run") });
const validInput = { action: "run" } as const;
const inputErrorMessage = "操作參數無效。";

function createVerifier(): AccessTokenVerifier {
  return vi.fn(async (token: string) => {
    if (token !== "valid-token") throw new AccessDeniedError();
    return owner;
  });
}

function makeHeaders(token?: string) {
  const headers = new Headers({ "x-request-id": requestId });
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return headers;
}

describe("private Server Action boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires the owner before the operation and returns a request ID on access denial", async () => {
    const verifyAccessToken = createVerifier();
    const operation = vi.fn(async () => ({ status: "unreachable" }));
    const onAccessDenied = vi.fn(async () => undefined);

    const result = await handlePrivateAction(makeHeaders(), {
      verifyAccessToken,
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation,
      onAccessDenied,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "access_denied",
      message: "無法驗證存取權限。",
      requestId,
    });
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(onAccessDenied).toHaveBeenCalledWith({ requestId });
  });

  it("re-authenticates with request headers and returns only the operation payload", async () => {
    const operation = vi.fn(async (authenticatedOwner: typeof owner) => {
      expect(authenticatedOwner).toEqual(owner);
      return { possibleDuplicate: true };
    });

    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation,
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({ ok: true, possibleDuplicate: true });
    expect(JSON.stringify(result)).not.toContain("owner-subject");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("maps named library conflicts to a safe discriminated failure", async () => {
    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation: async () => {
        throw new LibraryConflictError("library_item_in_use", "仍有遊戲使用此標籤，請先移除關係。");
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "library_conflict",
      message: "仍有遊戲使用此標籤，請先移除關係。",
      requestId,
    });
  });

  it("rejects invalid input before calling the operation", async () => {
    const operation = vi.fn(async () => ({ possibleDuplicate: true }));

    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: { action: "invalid" },
      schema: inputSchema,
      inputErrorMessage,
      operation,
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_input",
      message: inputErrorMessage,
      requestId,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves source identity conflict details needed by the UI", async () => {
    const existingGameId = "22222222-2222-4222-8222-222222222222";
    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation: async () => {
        throw new SourceIdentityConflictError(existingGameId, true);
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "source_operation",
      message: "此來源已存在於資源回收區，請先還原。",
      requestId,
      existingGameId,
      existingIsTrashed: true,
    });
  });

  it("preserves a source rate-limit retry hint without exposing internals", async () => {
    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation: async () => {
        throw new SourceRateLimitedError(30);
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "source_operation",
      message: "來源目前忙碌，請稍後再試。",
      requestId,
      retryAfterSeconds: 30,
    });
  });

  it("maps source failures to their named safe message", async () => {
    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation: async () => {
        throw new SourceUnavailableError();
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      code: "source_operation",
      message: "來源暫時無法使用，請稍後再試。",
      requestId,
    });
  });

  it("reports unknown failures safely and keeps observer failure visible without changing the result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onUnhandledFailure = vi.fn(async () => {
      throw new Error("observer secret");
    });

    const result = await handlePrivateAction(makeHeaders("valid-token"), {
      verifyAccessToken: createVerifier(),
      input: validInput,
      schema: inputSchema,
      inputErrorMessage,
      operation: async () => {
        throw new Error("database password");
      },
      onAccessDenied: async () => undefined,
      onUnhandledFailure,
    });

    expect(result).toEqual({
      ok: false,
      code: "operation_failed",
      message: "暫時無法完成操作。",
      requestId,
    });
    expect(onUnhandledFailure).toHaveBeenCalledWith({
      errorCode: "private_operation_failed",
      requestId,
    });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain("failure_observer_failed");
    expect(consoleError.mock.calls[0]?.[0]).not.toContain("database password");
    expect(consoleError.mock.calls[0]?.[0]).not.toContain("observer secret");
  });
});

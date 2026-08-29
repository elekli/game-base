import { describe, expect, it } from "vitest";
import { serializeLogEvent } from "./structured-log";

describe("serializeLogEvent", () => {
  it("serializes only the structured-log allowlist", () => {
    const serialized = serializeLogEvent({
      event: "access_jwt_rejected",
      level: "warn",
      requestId: "36b8f84d-df4e-4d49-b662-bcde71a8764f",
      operation: "private_ping",
      errorCode: "access_denied",
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: 12,
      environment: "preview",
      token: "must-not-appear",
      cookie: "must-not-appear",
      filename: "private.pdf",
    });

    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed).toEqual({
      event: "access_jwt_rejected",
      level: "warn",
      requestId: "36b8f84d-df4e-4d49-b662-bcde71a8764f",
      operation: "private_ping",
      errorCode: "access_denied",
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: 12,
      environment: "preview",
    });
    expect(serialized).not.toContain("must-not-appear");
    expect(serialized).not.toContain("private.pdf");
  });
});

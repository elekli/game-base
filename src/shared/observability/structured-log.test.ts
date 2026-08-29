import { describe, expect, it } from "vitest";
import {
  serializeBootstrapLogEvent,
  serializeLogEvent,
} from "./structured-log";

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

  it("allowlists bootstrap failures without inventing a deployment environment", () => {
    const serialized = serializeBootstrapLogEvent({
      event: "private_request_failed",
      level: "error",
      requestId: "36b8f84d-df4e-4d49-b662-bcde71a8764f",
      operation: "private_ping",
      errorCode: "runtime_config_invalid",
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: null,
      secret: "must-not-appear",
    });

    expect(JSON.parse(serialized)).toEqual({
      event: "private_request_failed",
      level: "error",
      requestId: "36b8f84d-df4e-4d49-b662-bcde71a8764f",
      operation: "private_ping",
      errorCode: "runtime_config_invalid",
      resourceType: null,
      resourceId: null,
      attempt: null,
      durationMs: null,
    });
    expect(serialized).not.toContain("must-not-appear");
  });
});

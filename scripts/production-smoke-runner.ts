import {
  type ProductionSmokeCanaryAction,
  type ProductionSmokeCanaryEvent,
} from "./production-smoke-canary";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 沒有獨立、驗簽的 smoke principal、route 與固定 canary schema 時，禁止發出任何請求。 */
export class ProductionSmokePrerequisiteError extends Error {
  constructor() {
    super("Production smoke is disabled until its signed principal, route, and fixed canary schema are approved.");
    this.name = "ProductionSmokePrerequisiteError";
  }
}

export class ProductionSmokeResponseError extends Error {
  constructor() {
    super("Production smoke response did not match the fixed contract.");
    this.name = "ProductionSmokeResponseError";
  }
}

export type ProductionSmokeRunner = Readonly<{
  execute(action: ProductionSmokeCanaryAction): Promise<ProductionSmokeCanaryEvent>;
}>;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(response: Response): string[] {
  const id = response.headers.get("x-request-id");
  if (id === null) return [];
  if (!UUID_V4.test(id)) throw new ProductionSmokeResponseError();
  return [id];
}

function counts(value: unknown): { rowCount: number; objectCount: number; rowIdentity?: string; objectIdentity?: string; rowPayloadSha256?: string; objectPayloadSha256?: string } {
  if (!record(value) || !Number.isInteger(value.rowCount) || !Number.isInteger(value.objectCount)) throw new ProductionSmokeResponseError();
  for (const key of ["rowIdentity", "objectIdentity", "rowPayloadSha256", "objectPayloadSha256"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new ProductionSmokeResponseError();
  }
  return value as ReturnType<typeof counts>;
}

/**
 * 將既有狀態模型的固定動作傳給未來專用 smoke route。
 * 現階段唯一允許的建構結果是 prerequisite error；此模組不建立 owner bypass。
 */
export function createProductionSmokeRunner(input: Readonly<{
  principalStatus: "approved" | "unresolved";
  routeAndSchemaStatus: "approved" | "unresolved";
  customDomain: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}>): ProductionSmokeRunner {
  if (input.principalStatus !== "approved" || input.routeAndSchemaStatus !== "approved") {
    throw new ProductionSmokePrerequisiteError();
  }
  if (!/^[a-z0-9.-]+$/.test(input.customDomain) || input.cfAccessClientId.trim() === "" || input.cfAccessClientSecret.trim() === "") {
    throw new ProductionSmokePrerequisiteError();
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new ProductionSmokePrerequisiteError();
  return {
    async execute(action) {
      if (action.kind === "stop") throw new ProductionSmokeResponseError();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`https://${input.customDomain}/api/internal/release-smoke`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "cf-access-client-id": input.cfAccessClientId,
            "cf-access-client-secret": input.cfAccessClientSecret,
          },
          body: JSON.stringify(action),
          signal: controller.signal,
        });
        if (!response.ok) throw new ProductionSmokeResponseError();
        const body = await response.json() as unknown;
        if (!record(body) || typeof body.kind !== "string") throw new ProductionSmokeResponseError();
        const ids = requestId(response);
        switch (body.kind) {
          case "counts-observed": return { kind: "counts-observed", purpose: body.purpose === "cleanup" ? "cleanup" : "baseline", ...counts(body), };
          case "fixed-read-checks-observed":
            if (!record(body.checks)) throw new ProductionSmokeResponseError();
            return { kind: "fixed-read-checks-observed", checks: body.checks as ProductionSmokeCanaryEvent & never, requestIds: ids } as ProductionSmokeCanaryEvent;
          case "row-written": return { kind: "row-written" };
          case "object-written": return { kind: "object-written" };
          case "round-trip-observed": return { kind: "round-trip-observed", ...counts(body), requestIds: ids };
          case "cleanup-finished": return { kind: "cleanup-finished" };
          default: throw new ProductionSmokeResponseError();
        }
      } finally { clearTimeout(timer); }
    },
  };
}

const VERCEL_API_ORIGIN = "https://api.vercel.com";

export class VercelRestConfigurationError extends Error {
  constructor() {
    super("Vercel REST client configuration is incomplete or unsafe.");
    this.name = "VercelRestConfigurationError";
  }
}

export class VercelRestHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Vercel REST request failed with status ${status}.`);
    this.name = "VercelRestHttpError";
    this.status = status;
  }
}

export class VercelRestTimeoutError extends Error {
  constructor() {
    super("Vercel REST request timed out.");
    this.name = "VercelRestTimeoutError";
  }
}

export class VercelRestNetworkError extends Error {
  constructor() {
    super("Vercel REST request failed before receiving a response.");
    this.name = "VercelRestNetworkError";
  }
}

export class VercelRestMalformedJsonError extends Error {
  constructor() {
    super("Vercel REST response was not valid JSON.");
    this.name = "VercelRestMalformedJsonError";
  }
}

export class VercelRestUnexpectedResponseError extends Error {
  constructor() {
    super("Vercel REST response did not match the expected shape.");
    this.name = "VercelRestUnexpectedResponseError";
  }
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type VercelEnvironmentVariable = Readonly<{
  id: string;
  key: string;
  target: string[];
  type: string;
}>;

type VercelEnvironmentListResponse = Readonly<{
  envs: VercelEnvironmentVariable[];
}>;

type VercelEnvironmentValue = Readonly<{ value: string }>;

type VercelProject = Readonly<{
  gitRepository?: object | null;
  id: string;
  link?: object | null;
  name: string;
}>;

export type VercelReadOnlyRestClient = Readonly<{
  getProject(projectId: string): Promise<VercelProject>;
  getProjectEnvironmentVariable(
    projectId: string,
    variableId: string,
  ): Promise<VercelEnvironmentValue>;
  listProjectEnvironmentVariables(
    projectId: string,
  ): Promise<VercelEnvironmentVariable[]>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvironmentVariable(value: unknown): VercelEnvironmentVariable {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.type !== "string" ||
    !(
      typeof value.target === "string" ||
      (Array.isArray(value.target) &&
        value.target.every((target) => typeof target === "string"))
    )
  ) {
    throw new VercelRestUnexpectedResponseError();
  }

  return {
    id: value.id,
    key: value.key,
    target: typeof value.target === "string" ? [value.target] : value.target,
    type: value.type,
  };
}

function parseEnvironmentList(value: unknown): VercelEnvironmentListResponse {
  const environmentValues =
    isRecord(value) && Array.isArray(value.envs) ? value.envs : [value];
  return { envs: environmentValues.map(parseEnvironmentVariable) };
}

function parseEnvironmentValue(value: unknown): VercelEnvironmentValue {
  if (!isRecord(value) || typeof value.value !== "string") {
    throw new VercelRestUnexpectedResponseError();
  }
  return { value: value.value };
}

function isObjectOrNull(value: unknown): value is object | null {
  return value === null || isRecord(value);
}

function parseProject(value: unknown): VercelProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    ("gitRepository" in value && !isObjectOrNull(value.gitRepository)) ||
    ("link" in value && !isObjectOrNull(value.link))
  ) {
    throw new VercelRestUnexpectedResponseError();
  }
  return {
    gitRepository: value.gitRepository as object | null | undefined,
    id: value.id,
    link: value.link as object | null | undefined,
    name: value.name,
  };
}

export function createVercelReadOnlyRestClient({
  fetchImpl = globalThis.fetch,
  teamId,
  timeoutMs,
  token,
}: Readonly<{
  fetchImpl?: FetchImplementation;
  teamId: string;
  timeoutMs: number;
  token: string;
}>): VercelReadOnlyRestClient {
  if (
    token.trim().length === 0 ||
    teamId.trim().length === 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new VercelRestConfigurationError();
  }
  const request = async (path: string) => {
    const url = new URL(path, VERCEL_API_ORIGIN);
    url.searchParams.set("teamId", teamId);
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new VercelRestTimeoutError());
      }, timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          fetchImpl(url, {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
            method: "GET",
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (timedOut || error instanceof VercelRestTimeoutError) {
          throw new VercelRestTimeoutError();
        }
        throw new VercelRestNetworkError();
      }
      if (!response.ok) {
        throw new VercelRestHttpError(response.status);
      }
      let responseText: string;
      try {
        responseText = await Promise.race([response.text(), timeoutPromise]);
      } catch (error) {
        if (timedOut || error instanceof VercelRestTimeoutError) {
          throw new VercelRestTimeoutError();
        }
        throw new VercelRestNetworkError();
      }
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        throw new VercelRestMalformedJsonError();
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };

  return {
    async getProject(projectId: string) {
      return parseProject(
        await request(`/v9/projects/${encodeURIComponent(projectId)}`),
      );
    },
    async getProjectEnvironmentVariable(projectId: string, variableId: string) {
      return parseEnvironmentValue(
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variableId)}`,
        ),
      );
    },
    async listProjectEnvironmentVariables(projectId: string) {
      const response = parseEnvironmentList(
        await request(`/v10/projects/${encodeURIComponent(projectId)}/env`),
      );
      return response.envs;
    },
  };
}

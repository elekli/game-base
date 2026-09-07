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
  gitRepository: object | null;
  id: string;
  link: object | null;
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

function parseEnvironmentList(value: unknown): VercelEnvironmentListResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.envs) ||
    !value.envs.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.key === "string" &&
        typeof item.type === "string" &&
        Array.isArray(item.target) &&
        item.target.every((target) => typeof target === "string"),
    )
  ) {
    throw new VercelRestUnexpectedResponseError();
  }

  return {
    envs: value.envs.map((item) => {
      const environment = item as Record<string, unknown>;
      return {
        id: environment.id as string,
        key: environment.key as string,
        target: environment.target as string[],
        type: environment.type as string,
      };
    }),
  };
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
    !("gitRepository" in value) ||
    !isObjectOrNull(value.gitRepository) ||
    !("link" in value) ||
    !isObjectOrNull(value.link)
  ) {
    throw new VercelRestUnexpectedResponseError();
  }
  return {
    gitRepository: value.gitRepository,
    id: value.id,
    link: value.link,
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
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
        if (error instanceof VercelRestTimeoutError) {
          throw error;
        }
        throw new VercelRestNetworkError();
      }
      if (!response.ok) {
        throw new VercelRestHttpError(response.status);
      }
      try {
        return await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (error instanceof VercelRestTimeoutError) {
          throw error;
        }
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

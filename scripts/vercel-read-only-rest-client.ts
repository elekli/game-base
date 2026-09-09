import {
  createVercelReadOnlyTransport,
  type VercelFetchImplementation,
  VercelRestMalformedResponseError,
} from "./vercel-rest-transport";

export {
  VercelRestConfigurationError,
  VercelRestHttpError,
  VercelRestMalformedJsonError,
  VercelRestMalformedResponseError,
  VercelRestNetworkError,
  VercelRestTimeoutError,
} from "./vercel-rest-transport";

export class VercelRestUnexpectedResponseError extends VercelRestMalformedResponseError {
  constructor() {
    super();
    this.message = "Vercel REST response did not match the expected shape.";
    this.name = "VercelRestUnexpectedResponseError";
  }
}

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
  autoAssignCustomDomains?: boolean;
  gitRepository?: object | null;
  id: string;
  link?: object | null;
  name: string;
}>;

type VercelProjectDomain = Readonly<{
  name: string;
  verified: boolean;
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
  listProjectDomains(projectId: string): Promise<VercelProjectDomain[]>;
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
    ("autoAssignCustomDomains" in value &&
      typeof value.autoAssignCustomDomains !== "boolean") ||
    ("gitRepository" in value && !isObjectOrNull(value.gitRepository)) ||
    ("link" in value && !isObjectOrNull(value.link))
  ) {
    throw new VercelRestUnexpectedResponseError();
  }
  return {
    autoAssignCustomDomains: value.autoAssignCustomDomains as
      | boolean
      | undefined,
    gitRepository: value.gitRepository as object | null | undefined,
    id: value.id,
    link: value.link as object | null | undefined,
    name: value.name,
  };
}

function parseProjectDomains(value: unknown): VercelProjectDomain[] {
  if (!isRecord(value) || !Array.isArray(value.domains)) {
    throw new VercelRestUnexpectedResponseError();
  }
  return value.domains.map((domain) => {
    if (
      !isRecord(domain) ||
      typeof domain.name !== "string" ||
      typeof domain.verified !== "boolean"
    ) {
      throw new VercelRestUnexpectedResponseError();
    }
    return { name: domain.name, verified: domain.verified };
  });
}

export function createVercelReadOnlyRestClient({
  fetchImpl = globalThis.fetch,
  maxResponseBytes,
  teamId,
  timeoutMs,
  token,
}: Readonly<{
  fetchImpl?: VercelFetchImplementation;
  maxResponseBytes?: number;
  teamId: string;
  timeoutMs: number;
  token: string;
}>): VercelReadOnlyRestClient {
  const transport = createVercelReadOnlyTransport({
    fetchImpl,
    maxResponseBytes,
    teamId,
    timeoutMs,
    token,
  });

  return {
    async getProject(projectId: string) {
      return parseProject(
        await transport.getJson(
          `/v9/projects/${encodeURIComponent(projectId)}`,
        ),
      );
    },
    async getProjectEnvironmentVariable(projectId: string, variableId: string) {
      return parseEnvironmentValue(
        await transport.getJson(
          `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variableId)}`,
        ),
      );
    },
    async listProjectEnvironmentVariables(projectId: string) {
      const response = parseEnvironmentList(
        await transport.getJson(
          `/v10/projects/${encodeURIComponent(projectId)}/env`,
        ),
      );
      return response.envs;
    },
    async listProjectDomains(projectId: string) {
      return parseProjectDomains(
        await transport.getJson(
          `/v9/projects/${encodeURIComponent(projectId)}/domains`,
        ),
      );
    },
  };
}

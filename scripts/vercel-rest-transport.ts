const VERCEL_API_ORIGIN = "https://api.vercel.com";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

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
    super("Vercel REST request failed before receiving a complete response.");
    this.name = "VercelRestNetworkError";
  }
}

export class VercelRestMalformedResponseError extends Error {
  constructor() {
    super("Vercel REST response was malformed or exceeded its safe size limit.");
    this.name = "VercelRestMalformedResponseError";
  }
}

export class VercelRestMalformedJsonError extends VercelRestMalformedResponseError {
  constructor() {
    super();
    this.message = "Vercel REST response was not valid JSON.";
    this.name = "VercelRestMalformedJsonError";
  }
}

export type VercelFetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type VercelReadOnlyTransport = Readonly<{
  getJson(
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<unknown>;
}>;


async function readBoundedBody(
  response: Response,
  limit: number,
  timeoutPromise: Promise<never>,
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      throw new VercelRestMalformedResponseError();
    }
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeoutPromise]);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        throw new VercelRestMalformedResponseError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof VercelRestMalformedResponseError) throw error;
    if (error instanceof VercelRestTimeoutError) throw error;
    throw new VercelRestNetworkError();
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export function createVercelReadOnlyTransport({
  fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  teamId,
  timeoutMs,
  token,
}: Readonly<{
  fetchImpl?: VercelFetchImplementation;
  maxResponseBytes?: number;
  teamId: string;
  timeoutMs: number;
  token: string;
}>): VercelReadOnlyTransport {
  if (
    token.trim().length === 0 ||
    token !== token.trim() ||
    /[\r\n]/.test(token) ||
    teamId.trim().length === 0 ||
    teamId !== teamId.trim() ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new VercelRestConfigurationError();
  }

  return {
    async getJson(path, query = {}) {
      if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path)) {
        throw new VercelRestConfigurationError();
      }
      const url = new URL(path, VERCEL_API_ORIGIN);
      if (url.origin !== VERCEL_API_ORIGIN) {
        throw new VercelRestConfigurationError();
      }
      for (const [key, value] of Object.entries(query)) {
        if (key === "teamId") throw new VercelRestConfigurationError();
        url.searchParams.set(key, String(value));
      }
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
        let body: Buffer;
        try {
          body = await readBoundedBody(
            response,
            maxResponseBytes,
            timeoutPromise,
          );
        } catch (error) {
          if (timedOut || error instanceof VercelRestTimeoutError) {
            throw new VercelRestTimeoutError();
          }
          throw error;
        }
        try {
          return JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          throw new VercelRestMalformedJsonError();
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

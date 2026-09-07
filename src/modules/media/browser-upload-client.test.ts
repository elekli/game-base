import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { DefaultHttpStack, type HttpStack } from "tus-js-client";
import { afterEach, describe, expect, it } from "vitest";
import { SupabaseMediaObjectStore } from "@/adapters/supabase-media-object-store";
import type { UploadGrant } from "./contracts";
import {
  createBrowserMediaUpload,
  MediaBrowserUploadError,
  type BrowserPreviousUpload,
  type BrowserUploadUrlStorage,
} from "./browser-upload-client";

const SIX_MIB = 6 * 1024 * 1024;

type RequestRecord = Readonly<{
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  byteSize: number;
}>;

function grant(endpoint: string, overrides: Partial<UploadGrant["upload"]> = {}): UploadGrant {
  return {
    status: "upload_grant",
    ingestId: "11111111-1111-4111-8111-111111111111",
    assetId: "22222222-2222-4222-8222-222222222222",
    upload: {
      protocol: "tus",
      endpoint,
      headers: { "x-signature": "signed-capability-secret" },
      metadata: {
        bucketName: "game-media",
        objectName: "originals/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333",
        contentType: "application/octet-stream",
        cacheControl: "0",
      },
      declaredByteSize: SIX_MIB + 11,
      maxByteSize: 50 * 1024 * 1024,
      chunkSize: 6_291_456,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      uploadDataDuringCreation: true,
      resumeFromPreviousUpload: true,
      removeFingerprintOnSuccess: true,
      upsert: false,
      fingerprint: "puizeru:11111111-1111-4111-8111-111111111111:originals/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333",
      ...overrides,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

class MemoryUrlStorage implements BrowserUploadUrlStorage {
  readonly entries = new Map<string, { fingerprint: string; upload: Omit<BrowserPreviousUpload, "urlStorageKey"> }>();
  removed: string[] = [];

  async findAllUploads(): Promise<BrowserPreviousUpload[]> {
    return [...this.entries.entries()].map(([urlStorageKey, entry]) => ({
      ...entry.upload,
      urlStorageKey,
    }));
  }

  async findUploadsByFingerprint(fingerprint: string): Promise<BrowserPreviousUpload[]> {
    return (await this.findAllUploads()).filter((entry) =>
      this.entries.get(entry.urlStorageKey)?.fingerprint === fingerprint,
    );
  }

  async removeUpload(urlStorageKey: string) {
    this.removed.push(urlStorageKey);
    this.entries.delete(urlStorageKey);
  }

  async addUpload(fingerprint: string, upload: BrowserPreviousUpload) {
    const key = `upload-${this.entries.size + 1}`;
    this.entries.set(key, {
      fingerprint,
      upload: {
        size: upload.size,
        metadata: upload.metadata,
        creationTime: upload.creationTime,
        uploadUrl: upload.uploadUrl,
        parallelUploadUrls: upload.parallelUploadUrls,
      },
    });
    return key;
  }
}

async function bodySize(request: import("node:http").IncomingMessage) {
  let size = 0;
  for await (const chunk of request) size += Buffer.byteLength(chunk);
  return size;
}

function decodeMetadata(value: string | undefined) {
  return Object.fromEntries((value ?? "").split(",").filter(Boolean).map((entry) => {
    const [key, encoded = ""] = entry.trim().split(" ");
    return [key, Buffer.from(encoded, "base64").toString("utf8")];
  }));
}

async function startTusServer(input: {
  missingFirstLocation?: boolean;
  loseFirstPatchResponse?: boolean;
  rejectCreationStatus?: number;
} = {}) {
  const requests: RequestRecord[] = [];
  const offsets = new Map<string, number>();
  let postCount = 0;
  let lostPatch = false;
  const server: Server = createServer(async (request, response) => {
    const method = request.method ?? "";
    const path = request.url ?? "";
    const size = await bodySize(request);
    requests.push({ method, path, headers: request.headers, byteSize: size });
    response.setHeader("Tus-Resumable", "1.0.0");

    if (method === "POST" && path === "/storage/v1/upload/resumable/sign") {
      postCount += 1;
      if (input.rejectCreationStatus) {
        response.statusCode = input.rejectCreationStatus;
        response.end();
        return;
      }
      const uploadPath = `/storage/v1/upload/resumable/sign/session-${postCount}`;
      offsets.set(uploadPath, size);
      response.statusCode = 201;
      response.setHeader("Upload-Offset", String(size));
      if (!(input.missingFirstLocation && postCount === 1)) response.setHeader("Location", uploadPath);
      response.end();
      return;
    }
    if (method === "HEAD" && offsets.has(path)) {
      response.statusCode = 200;
      response.setHeader("Upload-Offset", String(offsets.get(path)));
      response.setHeader("Upload-Length", String(SIX_MIB + 11));
      response.end();
      return;
    }
    if (method === "PATCH" && offsets.has(path)) {
      const nextOffset = Number(request.headers["upload-offset"]) + size;
      offsets.set(path, nextOffset);
      if (input.loseFirstPatchResponse && !lostPatch) {
        lostPatch = true;
        request.socket.destroy();
        return;
      }
      response.statusCode = 204;
      response.setHeader("Upload-Offset", String(nextOffset));
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const httpStack: HttpStack = {
    getName: () => "LocalTusTestStack",
    createRequest(method, url) {
      const original = new URL(url);
      return new DefaultHttpStack({}).createRequest(method, `${localOrigin}${original.pathname}${original.search}`);
    },
  };
  return {
    endpoint: "https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign",
    localEndpoint: `${localOrigin}/storage/v1/upload/resumable/sign`,
    httpStack,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("browser media TUS upload", () => {
  it.each([
    "http://127.0.0.1:54321/storage/v1/upload/resumable/sign",
    "http://localhost:54321/storage/v1/upload/resumable/sign",
  ])("accepts the exact local Supabase development TUS endpoint: %s", async (endpoint) => {
    const uploadGrant = grant(endpoint);
    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
      httpStack: {
        getName: () => "NoNetworkExpected",
        createRequest: () => { throw new Error("accepted grant reached TUS start"); },
      },
    });

    await expect(task.completion).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "media_upload_failed" }),
    });
  });

  it.each([
    "https://fixture.storage.supabase.co/storage/v1/upload/resumable",
    "http://127.0.0.1/storage/v1/upload/resumable/sign",
    "http://localhost/storage/v1/upload/resumable/sign",
    "http://0.0.0.0:54321/storage/v1/upload/resumable/sign",
    "http://127.0.0.1.evil.test:54321/storage/v1/upload/resumable/sign",
    "http://user@127.0.0.1:54321/storage/v1/upload/resumable/sign",
    "http://127.0.0.1:54321/storage/v1/upload/resumable/sign?token=x",
    "http://127.0.0.1:54321/storage/v1/upload/resumable/sign#fragment",
    "http://127.0.0.1:54321/storage/v1/upload/resumable/sign/other",
  ])("rejects a widened local TUS endpoint without touching the network: %s", async (endpoint) => {
    const uploadGrant = grant(endpoint);
    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
    });
    await expect(task.completion).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "media_upload_grant_invalid" }),
    });
  });

  it("passes the local endpoint produced by SupabaseMediaObjectStore unchanged into the real TUS client", async () => {
    const tus = await startTusServer();
    servers.push(tus);
    const baseGrant = grant(tus.localEndpoint);
    const path = baseGrant.upload.metadata.objectName;
    const filesApiToken = "fake-files-api-signed-token";
    const adapter = new SupabaseMediaObjectStore({
      supabaseUrl: new URL(tus.localEndpoint).origin,
      bucket: "game-media",
      files: {
        createSignedUploadUrl: async () => ({
          data: { path, token: filesApiToken, signedUrl: "unused-by-tus-client" },
          error: null,
        }),
      } as never,
    });
    const serverGrant = await adapter.createUploadGrant(path);
    const uploadGrant: UploadGrant = {
      ...baseGrant,
      expiresAt: serverGrant.expiresAt,
      upload: {
        ...baseGrant.upload,
        endpoint: serverGrant.uploadUrl,
        headers: { "x-signature": serverGrant.token },
      },
    };

    expect(serverGrant.uploadUrl).toBe(tus.localEndpoint);
    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
    });
    await expect(task.completion).resolves.toEqual({ status: "uploaded" });
    expect(tus.requests.every((request) => request.headers["x-signature"] === filesApiToken)).toBe(true);
  });

  it("uses the real TUS client to split a file larger than 6 MiB and never enables overwrite", async () => {
    const tus = await startTusServer();
    servers.push(tus);
    const storage = new MemoryUrlStorage();
    const uploadGrant = grant(tus.endpoint);
    const file = new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]);

    const task = createBrowserMediaUpload({ grant: uploadGrant, file, urlStorage: storage, httpStack: tus.httpStack });
    await expect(task.completion).resolves.toEqual({ status: "uploaded" });

    const transferred = tus.requests.filter((request) => request.method === "POST" || request.method === "PATCH");
    expect(transferred.map((request) => request.byteSize)).toEqual([SIX_MIB, 11]);
    expect(transferred.every((request) => request.headers["x-signature"] === "signed-capability-secret")).toBe(true);
    expect(transferred.every((request) => request.headers["x-upsert"] === undefined)).toBe(true);
    expect(decodeMetadata(transferred[0]?.headers["upload-metadata"] as string | undefined)).toEqual(uploadGrant.upload.metadata);
    expect(storage.entries.size).toBe(0);
    expect(storage.removed).toEqual(["upload-1"]);
  });

  it("retries a creation response without Location, then survives a lost PATCH response using the acquired URL", async () => {
    const tus = await startTusServer({ missingFirstLocation: true, loseFirstPatchResponse: true });
    servers.push(tus);
    const uploadGrant = grant(tus.endpoint);
    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
      httpStack: tus.httpStack,
    });

    await expect(task.completion).resolves.toMatchObject({ status: "uploaded" });
    expect(tus.requests.filter((request) => request.method === "POST")).toHaveLength(2);
    expect(tus.requests.some((request) => request.method === "HEAD" && request.path.endsWith("/session-2"))).toBe(true);
    expect(tus.requests.filter((request) => request.method === "PATCH").map((request) => request.path))
      .toEqual([expect.stringMatching(/session-2$/)]);
  });

  it("resumes an exact stored upload URL instead of creating or overwriting another object", async () => {
    const tus = await startTusServer();
    servers.push(tus);
    const uploadGrant = grant(tus.endpoint);
    const storage = new MemoryUrlStorage();
    // Give the fake server an existing resource by creating it once outside the client seam.
    await fetch(tus.localEndpoint, { method: "POST", headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "0" } });
    storage.entries.set("prior", {
      fingerprint: uploadGrant.upload.fingerprint,
      upload: {
        uploadUrl: `${tus.endpoint}/session-1`,
        size: uploadGrant.upload.declaredByteSize,
        metadata: uploadGrant.upload.metadata,
        creationTime: "2026-09-06T00:00:00.000Z",
        parallelUploadUrls: null,
      },
    });

    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: storage,
      httpStack: tus.httpStack,
    });
    await expect(task.completion).resolves.toMatchObject({ status: "uploaded" });

    expect(tus.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(tus.requests.some((request) => request.method === "HEAD" && request.path.endsWith("/session-1"))).toBe(true);
    expect(tus.requests.filter((request) => request.method === "PATCH").map((request) => request.byteSize)).toEqual([SIX_MIB, 11]);
  });

  it("rejects a loosened grant before sending a request and returns named cancellation", async () => {
    const tus = await startTusServer();
    servers.push(tus);
    const loosenedGrants = [
      grant(tus.endpoint, { upsert: true as false }),
      grant(tus.endpoint, {
        metadata: {
          bucketName: "game-media",
          objectName: "originals/99999999-9999-4999-8999-999999999999/33333333-3333-4333-8333-333333333333",
          contentType: "application/octet-stream",
          cacheControl: "0",
        },
      }),
    ];
    for (const uploadGrant of loosenedGrants) {
      const rejected = createBrowserMediaUpload({
        grant: uploadGrant,
        file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
        urlStorage: new MemoryUrlStorage(),
        httpStack: tus.httpStack,
      });
      await expect(rejected.completion).resolves.toEqual({
        status: "failed",
        error: expect.objectContaining({ name: "MediaBrowserUploadError", code: "media_upload_grant_invalid" }),
      });
    }
    expect(tus.requests).toEqual([]);

    const validGrant = grant(tus.endpoint);
    const cancelled = createBrowserMediaUpload({
      grant: validGrant,
      file: new Blob([new Uint8Array(validGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
      httpStack: tus.httpStack,
    });
    await cancelled.cancel();
    await expect(cancelled.completion).resolves.toEqual({ status: "cancelled" });
    expect(MediaBrowserUploadError).toBeTypeOf("function");
  });

  it("maps a terminal TUS protocol failure to a named result without exposing capability data", async () => {
    const tus = await startTusServer({ rejectCreationStatus: 403 });
    servers.push(tus);
    const uploadGrant = grant(tus.endpoint);
    const task = createBrowserMediaUpload({
      grant: uploadGrant,
      file: new Blob([new Uint8Array(uploadGrant.upload.declaredByteSize)]),
      urlStorage: new MemoryUrlStorage(),
      httpStack: tus.httpStack,
    });

    const result = await task.completion;
    expect(result).toEqual({
      status: "failed",
      error: expect.objectContaining({ name: "MediaBrowserUploadError", code: "media_upload_failed" }),
    });
    expect(tus.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(uploadGrant.upload.headers["x-signature"]);
    expect(JSON.stringify(result)).not.toContain(uploadGrant.upload.endpoint);
  });
});

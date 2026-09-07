import "server-only";
import { createClient } from "@supabase/supabase-js";
import { MediaStorageUnavailableError } from "@/modules/media";
import type { MediaObjectStore } from "@/modules/media/internal/types";

type StorageResult<T> = Promise<Readonly<{ data: T; error: null }> | Readonly<{ data: null; error: unknown }>>;
type FilesApi = Readonly<{
  createSignedUploadUrl(path: string, options: Readonly<{ upsert: boolean }>): StorageResult<Readonly<{ path: string; token: string; signedUrl: string }>>;
  createSignedUrl(path: string, expiresIn: number, options?: Readonly<{ download: string }>): StorageResult<Readonly<{ signedUrl: string }>>;
  info(path: string): StorageResult<Readonly<{ name: string; size?: number; contentType?: string }>>;
  download(path: string): Readonly<{ asStream(): Promise<Readonly<{ data: ReadableStream<Uint8Array> | null; error: unknown }>> }>;
  upload(path: string, body: Uint8Array, options: Readonly<{ contentType: "image/webp"; upsert: false; cacheControl: "0" }>): StorageResult<Readonly<{ path: string }>>;
  remove(paths: readonly string[]): StorageResult<readonly { name: string }[]>;
}>;

function directTusEndpoint(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  if (url.protocol === "https:" && url.hostname.endsWith(".supabase.co") && !url.hostname.endsWith(".storage.supabase.co")) {
    url.hostname = url.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  }
  url.pathname = "/storage/v1/upload/resumable/sign";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const ORIGINAL_PATH = /^originals\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DERIVATIVE_PATH = /^thumbnails\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/thumb_webp_v1\/[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;

function assertOriginalPath(path: string): void {
  if (!ORIGINAL_PATH.test(path)) throw new MediaStorageUnavailableError();
}

function assertDerivativePath(path: string): void {
  if (!DERIVATIVE_PATH.test(path)) throw new MediaStorageUnavailableError();
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.status === 404 || record.statusCode === "404" || record.code === "404";
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class SupabaseMediaObjectStore implements MediaObjectStore {
  private readonly files: FilesApi;
  private readonly now: () => Date;
  private readonly tusEndpoint: string;
  private readonly storageOrigin: string;
  private readonly bucket: "game-media";

  constructor(input: Readonly<{
    supabaseUrl: string;
    bucket: "game-media";
    secretKey?: string;
    files?: FilesApi;
    now?: () => Date;
  }>) {
    if (!input.files && !input.secretKey) throw new MediaStorageUnavailableError();
    this.files = input.files ?? createClient(input.supabaseUrl, input.secretKey as string, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }).storage.from(input.bucket) as unknown as FilesApi;
    this.now = input.now ?? (() => new Date());
    this.tusEndpoint = directTusEndpoint(input.supabaseUrl);
    this.storageOrigin = new URL(input.supabaseUrl).origin;
    this.bucket = input.bucket;
  }

  async createUploadGrant(path: string) {
    assertOriginalPath(path);
    try {
      const { data, error } = await this.files.createSignedUploadUrl(path, { upsert: false });
      if (error || !data || data.path !== path || !data.token) throw new MediaStorageUnavailableError();
      return { uploadUrl: this.tusEndpoint, token: data.token, expiresAt: new Date(this.now().getTime() + 2 * 60 * 60 * 1000).toISOString() };
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async createOriginalReadGrant(path: string, fileName: string, dispositionOrExpires: "inline" | "attachment" | 60 = "attachment", maybeExpiresInSeconds: 60 = 60) {
    assertOriginalPath(path);
    const disposition = typeof dispositionOrExpires === "number" ? "attachment" : dispositionOrExpires;
    const expiresInSeconds = typeof dispositionOrExpires === "number" ? dispositionOrExpires : maybeExpiresInSeconds;
    try {
      const { data, error } = disposition === "attachment"
        ? await this.files.createSignedUrl(path, expiresInSeconds, { download: fileName })
        : await this.files.createSignedUrl(path, expiresInSeconds);
      if (error || !data?.signedUrl) throw new MediaStorageUnavailableError();
      const signed = new URL(data.signedUrl);
      const expectedPath = `/storage/v1/object/sign/${encodeURIComponent(this.bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const queryKeys = [...signed.searchParams.keys()];
      if (
        signed.origin !== this.storageOrigin || signed.username || signed.password ||
        signed.pathname !== expectedPath ||
        signed.searchParams.getAll("token").length !== 1 || !signed.searchParams.get("token") ||
        (disposition === "attachment" && (signed.searchParams.getAll("download").length !== 1 || signed.searchParams.get("download") !== fileName)) ||
        (disposition === "inline" && signed.searchParams.has("download")) ||
        queryKeys.some((key) => key !== "token" && (disposition === "attachment" ? key !== "download" : true))
      ) throw new MediaStorageUnavailableError();
      return { url: data.signedUrl, expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1000).toISOString() };
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async createThumbnailReadGrant(path: string, expiresInSeconds = 300) {
    assertDerivativePath(path);
    try {
      const { data, error } = await this.files.createSignedUrl(path, expiresInSeconds);
      if (error || !data?.signedUrl) throw new MediaStorageUnavailableError();
      const signed = new URL(data.signedUrl);
      const expectedPath = `/storage/v1/object/sign/${encodeURIComponent(this.bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const queryKeys = [...signed.searchParams.keys()];
      if (signed.origin !== this.storageOrigin || signed.username || signed.password || signed.pathname !== expectedPath
        || signed.searchParams.getAll("token").length !== 1 || !signed.searchParams.get("token")
        || queryKeys.some((key) => key !== "token")) throw new MediaStorageUnavailableError();
      return { url: data.signedUrl, expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1000).toISOString() };
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async inspect(path: string) {
    assertOriginalPath(path);
    try {
      const { data, error } = await this.files.info(path);
      if (error) {
        if (isNotFound(error)) return null;
        throw new MediaStorageUnavailableError();
      }
      if (!data || data.name !== path || !Number.isSafeInteger(data.size) || (data.size as number) < 0 || typeof data.contentType !== "string") throw new MediaStorageUnavailableError();
      return { path, byteSize: data.size as number, mimeType: data.contentType };
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async *read(path: string): AsyncIterable<Uint8Array> {
    assertOriginalPath(path);
    try {
      const { data, error } = await this.files.download(path).asStream();
      if (error || !data) throw new MediaStorageUnavailableError();
      yield* streamChunks(data);
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async uploadDerivative(path: string, bytes: Uint8Array): Promise<void> {
    assertDerivativePath(path);
    if (bytes.byteLength === 0) throw new MediaStorageUnavailableError();
    try {
      const { data, error } = await this.files.upload(path, bytes, { contentType: "image/webp", upsert: false, cacheControl: "0" });
      if (error || !data || data.path !== path) throw new MediaStorageUnavailableError();
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }

  async deleteDerivative(path: string): Promise<void> {
    assertDerivativePath(path);
    try {
      const { error } = await this.files.remove([path]);
      if (error && !isNotFound(error)) throw new MediaStorageUnavailableError();
    } catch (error) { throw error instanceof MediaStorageUnavailableError ? error : new MediaStorageUnavailableError(); }
  }
}

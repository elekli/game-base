import "server-only";
import { createClient } from "@supabase/supabase-js";
import { ExternalReferenceThumbnailUnavailableError, type ExternalThumbnailObjects } from "@/modules/lists/external-reference-thumbnail";

type StorageResult<T> = Promise<Readonly<{ data: T; error: null }> | Readonly<{ data: null; error: unknown }>>;
type FilesApi = Readonly<{
  upload(path: string, body: Uint8Array, options: Readonly<{ contentType: "image/webp"; upsert: true; cacheControl: "0" }>): StorageResult<Readonly<{ path: string }>>;
  createSignedUrl(path: string, expiresIn: number): StorageResult<Readonly<{ signedUrl: string }>>;
}>;
const PATH = /^external-reference-thumbnails\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}\.webp$/i;

export class ExternalThumbnailObjectStore implements ExternalThumbnailObjects {
  private readonly files: FilesApi;
  private readonly storageOrigin: string;
  constructor(input: Readonly<{ supabaseUrl: string; secretKey?: string; files?: FilesApi }>) {
    if (!input.files && !input.secretKey) throw new ExternalReferenceThumbnailUnavailableError();
    this.files = input.files ?? createClient(input.supabaseUrl, input.secretKey as string, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }).storage.from("game-media") as unknown as FilesApi;
    this.storageOrigin = new URL(input.supabaseUrl).origin;
  }
  async upload(objectKey: string, bytes: Uint8Array): Promise<void> {
    if (!PATH.test(objectKey) || bytes.byteLength === 0) throw new ExternalReferenceThumbnailUnavailableError();
    const { data, error } = await this.files.upload(objectKey, bytes, { contentType: "image/webp", upsert: true, cacheControl: "0" });
    if (error || data?.path !== objectKey) throw new ExternalReferenceThumbnailUnavailableError();
  }
  async issueRead(objectKey: string): Promise<string> {
    if (!PATH.test(objectKey)) throw new ExternalReferenceThumbnailUnavailableError();
    const { data, error } = await this.files.createSignedUrl(objectKey, 300);
    if (error || !data?.signedUrl) throw new ExternalReferenceThumbnailUnavailableError();
    const signed = new URL(data.signedUrl);
    const expectedPath = `/storage/v1/object/sign/game-media/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
    if (signed.origin !== this.storageOrigin || signed.pathname !== expectedPath || signed.username || signed.password || signed.searchParams.getAll("token").length !== 1 || !signed.searchParams.get("token") || [...signed.searchParams.keys()].some((key) => key !== "token")) throw new ExternalReferenceThumbnailUnavailableError();
    return data.signedUrl;
  }
}

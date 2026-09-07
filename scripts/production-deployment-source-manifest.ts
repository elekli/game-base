import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

const FULL_SHA = /^[a-f0-9]{40}$/;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_PRODUCTION_SOURCE_PATH_UTF8_BYTES = 1024;
export const MAX_PRODUCTION_SOURCE_FILE_COUNT = 20_000;
export const MAX_PRODUCTION_SOURCE_BLOB_BYTES = 50 * 1024 * 1024;
export const MAX_PRODUCTION_SOURCE_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_PRODUCTION_CANONICAL_MANIFEST_BYTES =
  512 +
  MAX_PRODUCTION_SOURCE_FILE_COUNT *
    (MAX_PRODUCTION_SOURCE_PATH_UTF8_BYTES * 2 + 112);
const MAX_GIT_PROCESSES = 3;
const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxTreeBytes: 16 * 1024 * 1024,
  maxFileCount: MAX_PRODUCTION_SOURCE_FILE_COUNT,
  maxBlobBytes: MAX_PRODUCTION_SOURCE_BLOB_BYTES,
  maxTotalBytes: MAX_PRODUCTION_SOURCE_TOTAL_BYTES,
});

export type ProductionDeploymentSourceManifestFile = Readonly<{
  path: string;
  sha1: string;
  size: number;
}>;

export type ProductionDeploymentSourceManifest = Readonly<{
  schemaVersion: 1;
  commitSha: string;
  files: ReadonlyArray<ProductionDeploymentSourceManifestFile>;
}>;

export type CanonicalProductionDeploymentSourceManifest = Readonly<{
  manifest: ProductionDeploymentSourceManifest;
  canonicalJson: Buffer;
  sourceManifestSha256: string;
}>;

type ManifestFailureCode =
  | "blob-missing"
  | "blob-type-mismatch"
  | "duplicate-path"
  | "git-object-read-failed"
  | "git-timeout"
  | "invalid-commit"
  | "invalid-utf8-path"
  | "manifest-invalid"
  | "manifest-byte-mismatch"
  | "malformed-tree-entry"
  | "resource-limit-exceeded"
  | "resource-limit-invalid"
  | "source-byte-mismatch"
  | "unsafe-path"
  | "unsupported-tree-entry";

export class ProductionDeploymentSourceManifestError extends Error {
  constructor(readonly code: ManifestFailureCode) {
    super(`Production deployment source manifest failed: ${code}.`);
    this.name = "ProductionDeploymentSourceManifestError";
  }
}

export class ProductionDeploymentSourceManifestByteMismatchError extends ProductionDeploymentSourceManifestError {
  constructor() {
    super("manifest-byte-mismatch");
    this.name = "ProductionDeploymentSourceManifestByteMismatchError";
  }
}

export class ProductionDeploymentSourceFileByteMismatchError extends ProductionDeploymentSourceManifestError {
  constructor() {
    super("source-byte-mismatch");
    this.name = "ProductionDeploymentSourceFileByteMismatchError";
  }
}

type GitTreeEntry = Readonly<{
  mode: string;
  objectId: string;
  path: string;
  pathBytes: Buffer;
  type: string;
}>;

type ProductionSourceResourceLimits = Readonly<{
  timeoutMs: number;
  maxTreeBytes: number;
  maxFileCount: number;
  maxBlobBytes: number;
  maxTotalBytes: number;
}>;

type TightenedProductionSourceResourceLimits = Partial<ProductionSourceResourceLimits>;
type GitProcessBudget = { deadlineAt: number; processCount: number };

function resolveResourceLimits(
  limits: TightenedProductionSourceResourceLimits | undefined,
): ProductionSourceResourceLimits {
  const keys = Object.keys(limits ?? {});
  if (
    keys.some(
      (key) =>
        !Object.hasOwn(DEFAULT_RESOURCE_LIMITS, key) ||
        !Number.isSafeInteger((limits as Record<string, unknown>)[key]) ||
        ((limits as Record<string, number>)[key] ?? 0) < 1 ||
        (limits as Record<string, number>)[key]! >
          DEFAULT_RESOURCE_LIMITS[
            key as keyof typeof DEFAULT_RESOURCE_LIMITS
          ],
    )
  ) {
    throw new ProductionDeploymentSourceManifestError(
      "resource-limit-invalid",
    );
  }
  return { ...DEFAULT_RESOURCE_LIMITS, ...limits };
}

function runGitCapture(
  repositoryRoot: string,
  args: ReadonlyArray<string>,
  options: Readonly<{ maxBytes: number; budget: GitProcessBudget }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    options.budget.processCount += 1;
    const remainingMs = options.budget.deadlineAt - Date.now();
    if (
      options.budget.processCount > MAX_GIT_PROCESSES ||
      remainingMs < 1
    ) {
      reject(
        new ProductionDeploymentSourceManifestError(
          options.budget.processCount > MAX_GIT_PROCESSES
            ? "resource-limit-exceeded"
            : "git-timeout",
        ),
      );
      return;
    }
    const child = spawn("git", args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ProductionDeploymentSourceManifestError("git-timeout"));
    }, remainingMs);
    const fail = (error: ProductionDeploymentSourceManifestError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > options.maxBytes) {
        fail(
          new ProductionDeploymentSourceManifestError(
            "resource-limit-exceeded",
          ),
        );
        return;
      }
      output.push(chunk);
    });
    child.once("error", () =>
      fail(
        new ProductionDeploymentSourceManifestError(
          "git-object-read-failed",
        ),
      ),
    );
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ProductionDeploymentSourceManifestError(
            "git-object-read-failed",
          ),
        );
        return;
      }
      resolve(Buffer.concat(output));
    });
  });
}

function hashGitBlobs(
  repositoryRoot: string,
  entries: ReadonlyArray<GitTreeEntry>,
  options: Readonly<{
    maxBlobBytes: number;
    maxTotalBytes: number;
    budget: GitProcessBudget;
  }>,
): Promise<ReadonlyArray<Readonly<{ sha1: string; size: number }>>> {
  return new Promise((resolve, reject) => {
    options.budget.processCount += 1;
    const remainingMs = options.budget.deadlineAt - Date.now();
    if (
      options.budget.processCount > MAX_GIT_PROCESSES ||
      remainingMs < 1
    ) {
      reject(
        new ProductionDeploymentSourceManifestError(
          options.budget.processCount > MAX_GIT_PROCESSES
            ? "resource-limit-exceeded"
            : "git-timeout",
        ),
      );
      return;
    }
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const results: Array<Readonly<{ sha1: string; size: number }>> = [];
    const headerBytes: number[] = [];
    let entryIndex = 0;
    let remainingBlobBytes: number | undefined;
    let currentBlobSize = 0;
    let totalBytes = 0;
    let hash = createHash("sha1");
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ProductionDeploymentSourceManifestError("git-timeout"));
    }, remainingMs);
    const fail = (error: ProductionDeploymentSourceManifestError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length && !settled) {
        if (remainingBlobBytes === undefined) {
          const byte = chunk[offset]!;
          offset += 1;
          if (byte !== 0x0a) {
            headerBytes.push(byte);
            if (headerBytes.length > 128) {
              fail(
                new ProductionDeploymentSourceManifestError(
                  "git-object-read-failed",
                ),
              );
            }
            continue;
          }
          const entry = entries[entryIndex];
          const header = Buffer.from(headerBytes).toString("ascii");
          headerBytes.length = 0;
          const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
          const size = match ? Number(match[2]) : Number.NaN;
          if (
            !entry ||
            match?.[1] !== entry.objectId ||
            !Number.isSafeInteger(size) ||
            size < 0
          ) {
            fail(
              new ProductionDeploymentSourceManifestError(
                "git-object-read-failed",
              ),
            );
            continue;
          }
          if (
            size > options.maxBlobBytes ||
            totalBytes + size > options.maxTotalBytes
          ) {
            fail(
              new ProductionDeploymentSourceManifestError(
                "resource-limit-exceeded",
              ),
            );
            continue;
          }
          currentBlobSize = size;
          totalBytes += size;
          remainingBlobBytes = size;
          hash = createHash("sha1");
          continue;
        }
        if (remainingBlobBytes > 0) {
          const take = Math.min(remainingBlobBytes, chunk.length - offset);
          hash.update(chunk.subarray(offset, offset + take));
          remainingBlobBytes -= take;
          offset += take;
          continue;
        }
        if (chunk[offset] !== 0x0a) {
          fail(
            new ProductionDeploymentSourceManifestError(
              "git-object-read-failed",
            ),
          );
          continue;
        }
        offset += 1;
        results.push({ sha1: hash.digest("hex"), size: currentBlobSize });
        entryIndex += 1;
        remainingBlobBytes = undefined;
      }
    });
    child.once("error", () =>
      fail(
        new ProductionDeploymentSourceManifestError(
          "git-object-read-failed",
        ),
      ),
    );
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ProductionDeploymentSourceManifestError(
            "git-object-read-failed",
          ),
        );
        return;
      }
      if (
        entryIndex !== entries.length ||
        remainingBlobBytes !== undefined ||
        headerBytes.length !== 0
      ) {
        reject(
          new ProductionDeploymentSourceManifestError(
            "git-object-read-failed",
          ),
        );
        return;
      }
      resolve(results);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${entries.map((entry) => entry.objectId).join("\n")}\n`);
  });
}

function decodePath(pathBytes: Buffer): string {
  let path: string;
  try {
    path = utf8Decoder.decode(pathBytes);
  } catch {
    throw new ProductionDeploymentSourceManifestError("invalid-utf8-path");
  }
  const segments = path.split("/");
  if (
    path.length === 0 ||
    pathBytes.length > MAX_PRODUCTION_SOURCE_PATH_UTF8_BYTES ||
    path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new ProductionDeploymentSourceManifestError("unsafe-path");
  }
  return path;
}

export function parseProductionGitTree(output: Uint8Array): GitTreeEntry[] {
  const bytes = Buffer.from(output);
  const entries: GitTreeEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const nul = bytes.indexOf(0, offset);
    if (nul === -1) {
      throw new ProductionDeploymentSourceManifestError(
        "malformed-tree-entry",
      );
    }
    const record = bytes.subarray(offset, nul);
    offset = nul + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) {
      throw new ProductionDeploymentSourceManifestError(
        "malformed-tree-entry",
      );
    }
    const header = record.subarray(0, tab).toString("ascii").split(" ");
    if (
      header.length !== 3 ||
      !/^[0-7]{6}$/.test(header[0] ?? "") ||
      !FULL_SHA.test(header[2] ?? "")
    ) {
      throw new ProductionDeploymentSourceManifestError(
        "malformed-tree-entry",
      );
    }
    const [mode, type, objectId] = header as [string, string, string];
    if (type !== "blob" || !REGULAR_BLOB_MODES.has(mode)) {
      throw new ProductionDeploymentSourceManifestError(
        "unsupported-tree-entry",
      );
    }
    const pathBytes = Buffer.from(record.subarray(tab + 1));
    const path = decodePath(pathBytes);
    const pathIdentity = pathBytes.toString("hex");
    if (paths.has(pathIdentity)) {
      throw new ProductionDeploymentSourceManifestError("duplicate-path");
    }
    paths.add(pathIdentity);
    entries.push({ mode, objectId, path, pathBytes, type });
  }
  return entries.sort((left, right) =>
    Buffer.compare(left.pathBytes, right.pathBytes),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateManifest(value: unknown): ProductionDeploymentSourceManifest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "commitSha", "files"]) ||
    value.schemaVersion !== 1 ||
    typeof value.commitSha !== "string" ||
    !FULL_SHA.test(value.commitSha) ||
    !Array.isArray(value.files) ||
    value.files.length > DEFAULT_RESOURCE_LIMITS.maxFileCount
  ) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  let totalBytes = 0;
  const files = value.files.map((file) => {
    const validated = validateProductionDeploymentSourceManifestFile(file);
    totalBytes += validated.size;
    if (totalBytes > MAX_PRODUCTION_SOURCE_TOTAL_BYTES) {
      throw new ProductionDeploymentSourceManifestError("manifest-invalid");
    }
    return validated;
  });
  const sortedFiles = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  for (let index = 0; index < sortedFiles.length; index += 1) {
    if (sortedFiles[index] !== files[index]) {
      throw new ProductionDeploymentSourceManifestError("manifest-invalid");
    }
    if (index > 0 && sortedFiles[index - 1]?.path === sortedFiles[index]?.path) {
      throw new ProductionDeploymentSourceManifestError("duplicate-path");
    }
  }
  return { schemaVersion: 1, commitSha: value.commitSha, files };
}

export function validateProductionDeploymentSourceManifestFile(
  value: unknown,
): ProductionDeploymentSourceManifestFile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["path", "size", "sha1"]) ||
    typeof value.path !== "string" ||
    value.path.length > MAX_PRODUCTION_SOURCE_PATH_UTF8_BYTES ||
    typeof value.sha1 !== "string" ||
    !FULL_SHA.test(value.sha1) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_PRODUCTION_SOURCE_BLOB_BYTES
  ) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  if (
    Buffer.byteLength(value.path, "utf8") >
    MAX_PRODUCTION_SOURCE_PATH_UTF8_BYTES
  ) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  const pathBytes = Buffer.from(value.path, "utf8");
  if (decodePath(pathBytes) !== value.path) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  return { path: value.path, size: value.size, sha1: value.sha1 };
}

export function canonicalizeProductionDeploymentSourceManifest(
  value: ProductionDeploymentSourceManifest,
): CanonicalProductionDeploymentSourceManifest {
  const manifest = validateManifest(value);
  const canonicalJson = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (canonicalJson.length > MAX_PRODUCTION_CANONICAL_MANIFEST_BYTES) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  return {
    manifest,
    canonicalJson,
    sourceManifestSha256: createHash("sha256")
      .update(canonicalJson)
      .digest("hex"),
  };
}

export function parseProductionDeploymentSourceManifest(
  bytes: Uint8Array,
): ProductionDeploymentSourceManifest {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_PRODUCTION_CANONICAL_MANIFEST_BYTES
  ) {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  const input = Buffer.from(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(input));
  } catch {
    throw new ProductionDeploymentSourceManifestError("manifest-invalid");
  }
  const canonical = canonicalizeProductionDeploymentSourceManifest(
    parsed as ProductionDeploymentSourceManifest,
  );
  if (
    input.length !== canonical.canonicalJson.length ||
    !timingSafeEqual(input, canonical.canonicalJson)
  ) {
    throw new ProductionDeploymentSourceManifestByteMismatchError();
  }
  return canonical.manifest;
}

export function verifyProductionDeploymentSourceFileBytes(
  file: ProductionDeploymentSourceManifestFile,
  bytes: Uint8Array,
): void {
  let validatedFile: ProductionDeploymentSourceManifestFile;
  try {
    validatedFile = validateProductionDeploymentSourceManifestFile(file);
  } catch {
    throw new ProductionDeploymentSourceFileByteMismatchError();
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_PRODUCTION_SOURCE_BLOB_BYTES ||
    bytes.byteLength !== validatedFile.size ||
    createHash("sha1").update(bytes).digest("hex") !== validatedFile.sha1
  ) {
    throw new ProductionDeploymentSourceFileByteMismatchError();
  }
}

export async function readProductionDeploymentSourceFileBytes({
  commitSha,
  file,
  repositoryRoot,
  timeoutMs = 10_000,
}: Readonly<{
  commitSha: string;
  file: ProductionDeploymentSourceManifestFile;
  repositoryRoot: string;
  timeoutMs?: number;
}>): Promise<Buffer> {
  if (
    !FULL_SHA.test(commitSha) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  ) {
    throw new ProductionDeploymentSourceFileByteMismatchError();
  }
  const validatedFile = validateProductionDeploymentSourceManifestFile(file);
  const bytes = await runGitCapture(
    repositoryRoot,
    ["cat-file", "blob", `${commitSha}:${validatedFile.path}`],
    {
      maxBytes: validatedFile.size,
      budget: { deadlineAt: Date.now() + timeoutMs, processCount: 0 },
    },
  ).catch(() => {
    throw new ProductionDeploymentSourceFileByteMismatchError();
  });
  verifyProductionDeploymentSourceFileBytes(validatedFile, bytes);
  return bytes;
}

export async function buildProductionDeploymentSourceManifest({
  commitSha,
  limits: requestedLimits,
  repositoryRoot,
}: Readonly<{
  commitSha: string;
  limits?: TightenedProductionSourceResourceLimits;
  repositoryRoot: string;
}>): Promise<CanonicalProductionDeploymentSourceManifest> {
  if (!FULL_SHA.test(commitSha)) {
    throw new ProductionDeploymentSourceManifestError("invalid-commit");
  }
  const limits = resolveResourceLimits(requestedLimits);
  const budget: GitProcessBudget = {
    deadlineAt: Date.now() + limits.timeoutMs,
    processCount: 0,
  };
  let commitType: Buffer;
  try {
    commitType = await runGitCapture(
      repositoryRoot,
      ["cat-file", "-t", commitSha],
      { maxBytes: 32, budget },
    );
  } catch (error) {
    if (
      error instanceof ProductionDeploymentSourceManifestError &&
      (error.code === "git-timeout" ||
        error.code === "resource-limit-exceeded")
    ) {
      throw error;
    }
    throw new ProductionDeploymentSourceManifestError("invalid-commit");
  }
  if (commitType.toString("ascii").trim() !== "commit") {
    throw new ProductionDeploymentSourceManifestError("invalid-commit");
  }
  const tree = parseProductionGitTree(
    await runGitCapture(
      repositoryRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commitSha],
      { maxBytes: limits.maxTreeBytes, budget },
    ),
  );
  if (tree.length > limits.maxFileCount) {
    throw new ProductionDeploymentSourceManifestError(
      "resource-limit-exceeded",
    );
  }
  let contents: ReadonlyArray<Readonly<{ sha1: string; size: number }>>;
  try {
    contents =
      tree.length === 0
        ? []
        : await hashGitBlobs(repositoryRoot, tree, {
            maxBlobBytes: limits.maxBlobBytes,
            maxTotalBytes: limits.maxTotalBytes,
            budget,
          });
  } catch (error) {
    if (
      error instanceof ProductionDeploymentSourceManifestError &&
      (error.code === "git-timeout" ||
        error.code === "resource-limit-exceeded")
    ) {
      throw error;
    }
    throw new ProductionDeploymentSourceManifestError("blob-missing");
  }
  const files = tree.map((entry, index) => ({
    path: entry.path,
    sha1: contents[index]!.sha1,
    size: contents[index]!.size,
  }));
  return canonicalizeProductionDeploymentSourceManifest({
    schemaVersion: 1,
    commitSha,
    files,
  });
}

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PRODUCTION_CANONICAL_MANIFEST_BYTES,
  MAX_PRODUCTION_SOURCE_BLOB_BYTES,
  ProductionDeploymentSourceManifestError,
  ProductionDeploymentSourceFileByteMismatchError,
  buildProductionDeploymentSourceManifest,
  canonicalizeProductionDeploymentSourceManifest,
  parseProductionGitTree,
  parseProductionDeploymentSourceManifest,
  readProductionDeploymentSourceFileBytes,
  verifyProductionDeploymentSourceFileBytes,
} from "../../scripts/production-deployment-source-manifest";

const execFileAsync = promisify(execFile);
const SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "deployment-manifest-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Manifest Test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.email", "manifest@example.test"], {
    cwd: root,
  });
  return root;
}

async function commitAll(root: string) {
  await execFileAsync("git", ["add", "--all"], { cwd: root });
  return commitIndex(root);
}

async function commitIndex(root: string) {
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: root,
  });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
  });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("production deployment source manifest", () => {
  it("reads exact regular blobs from the commit object database and ignores the working tree", async () => {
    const root = await createRepository();
    await mkdir(join(root, "utf 8"));
    await writeFile(join(root, "a b.txt"), "committed\n");
    await writeFile(join(root, "utf 8", "遊戲.txt"), "遊戲\n");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho ok\n", {
      mode: 0o755,
    });
    const commitSha = await commitAll(root);

    await writeFile(join(root, "a b.txt"), "working tree must be ignored\n");
    await rm(join(root, "utf 8", "遊戲.txt"));

    const result = await buildProductionDeploymentSourceManifest({
      commitSha,
      repositoryRoot: root,
    });

    expect(result.manifest.files).toEqual([
      {
        path: "a b.txt",
        sha1: "9538914e935ee6babb3e669155e8a39324282787",
        size: 10,
      },
      {
        path: "run.sh",
        sha1: "6899932257a582a8a0e358aed9a0adbbfee79dda",
        size: 18,
      },
      {
        path: "utf 8/遊戲.txt",
        sha1: "24b9d37f6f788c0208747f818879fedb9e873793",
        size: 7,
      },
    ]);
    expect(result.manifest.commitSha).toBe(commitSha);
    expect(result.canonicalJson.at(-1)).toBe(0x0a);
    expect(parseProductionDeploymentSourceManifest(result.canonicalJson)).toEqual(
      result.manifest,
    );
    await expect(
      readProductionDeploymentSourceFileBytes({
        commitSha,
        file: result.manifest.files[0]!,
        repositoryRoot: root,
      }),
    ).resolves.toEqual(Buffer.from("committed\n"));
  });

  it("uses one byte-identical canonical JSON representation and fingerprints those bytes", () => {
    const result = canonicalizeProductionDeploymentSourceManifest({
      schemaVersion: 1,
      commitSha: SHA,
      files: [
        {
          path: "a b.txt",
          size: 10,
          sha1: "9538914e935ee6babb3e669155e8a39324282787",
        },
      ],
    });

    expect(result.canonicalJson.toString("utf8")).toBe(
      `{"schemaVersion":1,"commitSha":"${SHA}","files":[{"path":"a b.txt","size":10,"sha1":"9538914e935ee6babb3e669155e8a39324282787"}]}\n`,
    );
    expect(result.sourceManifestSha256).toBe(
      "a0df5c3194d1ccb43a61c73209c4a47a09a907c080c1edfcd3e1d328fca999d4",
    );

    const nonCanonical = Buffer.from(
      `{"commitSha":"${SHA}","schemaVersion":1,"files":[]}\n`,
    );
    expect(() => parseProductionDeploymentSourceManifest(nonCanonical)).toThrow(
      ProductionDeploymentSourceManifestError,
    );
  });

  it("rejects oversized external canonical bytes before decoding or parsing", () => {
    const oversized = Buffer.alloc(
      MAX_PRODUCTION_CANONICAL_MANIFEST_BYTES + 1,
      0x7b,
    );
    expect(() => parseProductionDeploymentSourceManifest(oversized)).toThrow(
      ProductionDeploymentSourceManifestError,
    );
  });

  it("applies immutable manifest limits during canonicalization", () => {
    const file = {
      path: "safe",
      size: 0,
      sha1: "a".repeat(40),
    };
    expect(() =>
      canonicalizeProductionDeploymentSourceManifest({
        schemaVersion: 1,
        commitSha: SHA,
        files: [{ ...file, path: "x".repeat(1025) }],
      }),
    ).toThrow();
    expect(() =>
      canonicalizeProductionDeploymentSourceManifest({
        schemaVersion: 1,
        commitSha: SHA,
        files: [{ ...file, size: 50 * 1024 * 1024 + 1 }],
      }),
    ).toThrow();
    expect(() =>
      canonicalizeProductionDeploymentSourceManifest({
        schemaVersion: 1,
        commitSha: SHA,
        files: Array.from({ length: 20_001 }, (_, index) => ({
          ...file,
          path: `file-${String(index).padStart(5, "0")}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      canonicalizeProductionDeploymentSourceManifest({
        schemaVersion: 1,
        commitSha: SHA,
        files: Array.from({ length: 21 }, (_, index) => ({
          ...file,
          path: `file-${String(index).padStart(2, "0")}`,
          size: 50 * 1024 * 1024,
        })),
      }),
    ).toThrow();
    expect(MAX_PRODUCTION_SOURCE_BLOB_BYTES).toBe(50 * 1024 * 1024);
  });

  it("rejects symlinks and submodules instead of following non-regular entries", async () => {
    const symlinkRoot = await createRepository();
    await writeFile(join(symlinkRoot, "target"), "target");
    await symlink("target", join(symlinkRoot, "link"));
    const symlinkCommit = await commitAll(symlinkRoot);

    await expect(
      buildProductionDeploymentSourceManifest({
        commitSha: symlinkCommit,
        repositoryRoot: symlinkRoot,
      }),
    ).rejects.toThrow(ProductionDeploymentSourceManifestError);

    const submoduleRoot = await createRepository();
    await execFileAsync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${symlinkCommit},nested`],
      { cwd: submoduleRoot },
    );
    const submoduleCommit = await commitIndex(submoduleRoot);

    await expect(
      buildProductionDeploymentSourceManifest({
        commitSha: submoduleCommit,
        repositoryRoot: submoduleRoot,
      }),
    ).rejects.toThrow(ProductionDeploymentSourceManifestError);
  });

  it("requires an exact lowercase commit object ID", async () => {
    const root = await createRepository();
    await writeFile(join(root, "file"), "content");
    const commitSha = await commitAll(root);

    await expect(
      buildProductionDeploymentSourceManifest({
        commitSha: commitSha.slice(0, 12),
        repositoryRoot: root,
      }),
    ).rejects.toThrow(ProductionDeploymentSourceManifestError);
  });

  it("rejects traversal, duplicate, and invalid UTF-8 tree paths", () => {
    const objectId = "a".repeat(40);
    const record = (path: Uint8Array) =>
      Buffer.concat([
        Buffer.from(`100644 blob ${objectId}\t`, "ascii"),
        Buffer.from(path),
        Buffer.from([0]),
      ]);

    expect(() => parseProductionGitTree(record(Buffer.from("../secret")))).toThrow(
      ProductionDeploymentSourceManifestError,
    );
    expect(() =>
      parseProductionGitTree(
        Buffer.concat([record(Buffer.from("same")), record(Buffer.from("same"))]),
      ),
    ).toThrow(ProductionDeploymentSourceManifestError);
    expect(() => parseProductionGitTree(record(Buffer.from([0xff])))).toThrow(
      ProductionDeploymentSourceManifestError,
    );
  });

  it("fails closed when tightened Git tree, file, blob, or total limits are exceeded", async () => {
    const root = await createRepository();
    await writeFile(join(root, "one"), "1234");
    await writeFile(join(root, "two"), "5678");
    const commitSha = await commitAll(root);

    for (const limits of [
      { maxTreeBytes: 8 },
      { maxFileCount: 1 },
      { maxBlobBytes: 3 },
      { maxTotalBytes: 7 },
    ]) {
      await expect(
        buildProductionDeploymentSourceManifest({
          commitSha,
          repositoryRoot: root,
          limits,
        }),
      ).rejects.toMatchObject({ code: "resource-limit-exceeded" });
    }

    await expect(
      buildProductionDeploymentSourceManifest({
        commitSha,
        repositoryRoot: root,
        limits: { maxFileCount: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toMatchObject({ code: "resource-limit-invalid" });
  });

  it("rejects a valid-length raw blob SHA mismatch without exposing path or bytes", () => {
    const secret = Buffer.from("file_bytes_must_not_escape");
    const error = (() => {
      try {
        verifyProductionDeploymentSourceFileBytes(
          {
            path: "safe.txt",
            sha1: "1".repeat(40),
            size: secret.length,
          },
          secret,
        );
      } catch (reason) {
        return reason;
      }
    })();

    expect(error).toBeInstanceOf(
      ProductionDeploymentSourceFileByteMismatchError,
    );
    expect(JSON.stringify(error)).not.toContain(secret.toString());
    expect((error as Error).message).not.toContain(secret.toString());
    expect((error as Error).message).not.toContain("safe.txt");
  });
});

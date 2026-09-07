import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalizeProductionDeploymentSourceManifest } from "../../scripts/production-deployment-source-manifest";
import { MAX_PRODUCTION_SOURCE_BLOB_BYTES } from "../../scripts/production-deployment-source-manifest";

import {
  VercelDeploymentIdentityAmbiguousError,
  VercelDeploymentMutationDisabledError,
  VercelDeploymentValidationError,
  VercelStagedProductionSafetyUnverifiedError,
  buildCreateVercelDeploymentRequest,
  buildGetVercelDeploymentRequest,
  buildGetVercelProductionAliasRequest,
  parseVercelProductionAlias,
  buildListVercelProductionDeploymentsRequest,
  buildPromoteVercelDeploymentRequest,
  buildRollbackVercelDeploymentRequest,
  buildUploadVercelFileRequest,
  createVercelDeploymentRestAdapter,
  parseReadyVercelProductionDeployment,
  resolveReusableVercelProductionDeployment,
} from "../../scripts/vercel-deployment-rest-adapter";
import type { VercelRestTransport } from "../../scripts/vercel-rest-transport";

const COMMIT_SHA = "a".repeat(40);
const MANIFEST_SHA256 = "b".repeat(64);
const RELEASE_IDENTITY = `production:${COMMIT_SHA}`;
const SOURCE_ARTIFACT = canonicalizeProductionDeploymentSourceManifest({
  schemaVersion: 1,
  commitSha: COMMIT_SHA,
  files: [
    {
      path: "src/遊戲 file.ts",
      sha1: "c".repeat(40),
      size: 17,
    },
  ],
});
const LIVE_SOURCE_BYTES = Buffer.from("verified-source-bytes");
const LIVE_SOURCE_ARTIFACT = canonicalizeProductionDeploymentSourceManifest({
  schemaVersion: 1,
  commitSha: COMMIT_SHA,
  files: [
    {
      path: "src/live.ts",
      sha1: createHash("sha1").update(LIVE_SOURCE_BYTES).digest("hex"),
      size: LIVE_SOURCE_BYTES.length,
    },
  ],
});

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    uid: "dpl_D1",
    url: "staged.example.test",
    projectId: "prj_project",
    state: "READY",
    target: "production",
    meta: {
      releaseCommit: COMMIT_SHA,
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestSha256: MANIFEST_SHA256,
    },
    ...overrides,
  };
}

describe("Vercel deployment REST adapter contract", () => {
  it("builds bounded read requests and validates the exact commit locally", () => {
    expect(buildGetVercelProductionAliasRequest({ customDomain: "game.example.com", projectId: "prj_project" })).toEqual({ method: "GET", path: "/v4/aliases/game.example.com", query: { projectId: "prj_project" } });
    expect(parseVercelProductionAlias({ alias: "game.example.com", projectId: "prj_project", deploymentId: "dpl_D1" }, { customDomain: "game.example.com", projectId: "prj_project" })).toBe("dpl_D1");
    expect(() => parseVercelProductionAlias({ alias: "other.example.com", projectId: "prj_project", deploymentId: "dpl_D1" }, { customDomain: "game.example.com", projectId: "prj_project" })).toThrow();
    expect(
      buildListVercelProductionDeploymentsRequest({
        commitSha: COMMIT_SHA,
        projectId: "prj_project",
      }),
    ).toEqual({
      method: "GET",
      path: "/v7/deployments",
      query: {
        limit: "100",
        projectId: "prj_project",
        target: "production",
      },
    });
    expect(
      buildListVercelProductionDeploymentsRequest({
        commitSha: COMMIT_SHA,
        projectId: "prj_project",
        until: 1234,
      }).query,
    ).toMatchObject({ limit: "100", until: "1234" });
    expect(buildGetVercelDeploymentRequest("dpl_D1")).toEqual({
      method: "GET",
      path: "/v13/deployments/dpl_D1",
    });
  });

  it("uploads exactly raw bytes under their raw SHA1 digest", () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const request = buildUploadVercelFileRequest(bytes, {
      path: "binary.bin",
      sha1: createHash("sha1").update(bytes).digest("hex"),
      size: bytes.length,
    });

    expect(request).toEqual({
      method: "POST",
      path: "/v2/files",
      headers: {
        "content-length": "4",
        "content-type": "application/octet-stream",
        "x-vercel-digest": createHash("sha1").update(bytes).digest("hex"),
      },
      body: bytes,
    });
    expect(() =>
      buildUploadVercelFileRequest(Buffer.from([9, 9, 9, 9]), {
        path: "mismatch.bin",
        sha1: createHash("sha1").update(bytes).digest("hex"),
        size: bytes.length,
      }),
    ).toThrow();
  });

  it("rejects oversized bytes and unsafe manifest paths before upload allocation", () => {
    const oversized = Buffer.allocUnsafe(MAX_PRODUCTION_SOURCE_BLOB_BYTES + 1);
    expect(() =>
      buildUploadVercelFileRequest(oversized, {
        path: "safe.bin",
        sha1: "a".repeat(40),
        size: oversized.byteLength,
      }),
    ).toThrow();
    expect(() =>
      buildUploadVercelFileRequest(Buffer.alloc(0), {
        path: "x".repeat(1025),
        sha1: createHash("sha1").update("").digest("hex"),
        size: 0,
      }),
    ).toThrow();
    expect(() =>
      buildUploadVercelFileRequest(Buffer.alloc(0), {
        path: "../escape",
        sha1: createHash("sha1").update("").digest("hex"),
        size: 0,
      }),
    ).toThrow();
  });

  it("requires explicit staged-domain safety before creating", () => {
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectId: "prj_project",
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: SOURCE_ARTIFACT,
        stagedProductionSafetyVerified: false,
      }),
    ).toThrow(VercelStagedProductionSafetyUnverifiedError);

    expect(
      buildCreateVercelDeploymentRequest({
        projectId: "prj_project",
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: SOURCE_ARTIFACT,
        stagedProductionSafetyVerified: true,
      }),
    ).toEqual({
      method: "POST",
      path: "/v13/deployments",
      query: { forceNew: "1", skipAutoDetectionConfirmation: "1" },
      body: {
        files: [
          { file: "src/遊戲 file.ts", sha: "c".repeat(40), size: 17 },
        ],
        meta: {
          releaseCommit: COMMIT_SHA,
          releaseIdentity: RELEASE_IDENTITY,
          sourceManifestSha256: SOURCE_ARTIFACT.sourceManifestSha256,
        },
        name: "game-base",
        project: "prj_project",
        target: "production",
      },
    });
  });

  it("derives create files, commit, and digest only from a verified canonical artifact", () => {
    const tamperedBytes = Buffer.from(SOURCE_ARTIFACT.canonicalJson);
    tamperedBytes[tamperedBytes.length - 2] ^= 1;
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectId: "prj_project",
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: {
          ...SOURCE_ARTIFACT,
          canonicalJson: tamperedBytes,
        },
        stagedProductionSafetyVerified: true,
      }),
    ).toThrow();
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectId: "prj_project",
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: {
          ...SOURCE_ARTIFACT,
          sourceManifestSha256: "d".repeat(64),
        },
        stagedProductionSafetyVerified: true,
      }),
    ).toThrow();
  });

  it("builds empty-body promote and rollback contracts", () => {
    expect(
      buildPromoteVercelDeploymentRequest({
        deploymentId: "dpl_D1",
        projectId: "prj_project",
      }),
    ).toEqual({
      method: "POST",
      path: "/v10/projects/prj_project/promote/dpl_D1",
    });
    expect(
      buildRollbackVercelDeploymentRequest({
        deploymentId: "dpl_D0",
        projectId: "prj_project",
      }),
    ).toEqual({
      method: "POST",
      path: "/v1/projects/prj_project/rollback/dpl_D0",
    });
  });

  it("uploads verified blobs, creates once, waits for READY, and exposes bounded mutations", async () => {
    const sourceManifestSha256 = LIVE_SOURCE_ARTIFACT.sourceManifestSha256;
    const created = deployment({
      state: "BUILDING",
      meta: {
        releaseCommit: COMMIT_SHA,
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestSha256,
      },
    });
    const getJson = vi
      .fn<VercelRestTransport["getJson"]>()
      .mockResolvedValueOnce({ deployments: [], pagination: { next: null } })
      .mockResolvedValueOnce({ ...created, state: "BUILDING" })
      .mockResolvedValueOnce({ ...created, state: "READY" });
    const postJson = vi
      .fn<VercelRestTransport["postJson"]>()
      .mockResolvedValueOnce(created)
      .mockResolvedValue({ ok: true });
    const postBytes = vi
      .fn<VercelRestTransport["postBytes"]>()
      .mockResolvedValue(undefined);
    const transport = { getJson, postJson, postBytes };
    const sleep = vi.fn(async () => undefined);
    const adapter = createVercelDeploymentRestAdapter({
      projectId: "prj_project",
      projectName: "game-base",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestArtifact: LIVE_SOURCE_ARTIFACT,
      stagedProductionSafetyVerified: true,
      transport,
      loadSourceFile: async () => LIVE_SOURCE_BYTES,
      sleep,
    });

    await expect(adapter.ensureStagedDeployment()).resolves.toMatchObject({
      commitSha: COMMIT_SHA,
      deploymentId: "dpl_D1",
      source: "created",
      sourceManifestSha256,
    });
    expect(postBytes).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenNthCalledWith(
      1,
      "/v13/deployments",
      expect.objectContaining({ project: "prj_project", target: "production" }),
      { forceNew: "1", skipAutoDetectionConfirmation: "1" },
      undefined,
    );
    await expect(
      adapter.awaitStagedReady({
        deploymentId: "dpl_D1",
        intervalMs: 5,
        maxAttempts: 2,
      }),
    ).resolves.toMatchObject({ deploymentId: "dpl_D1" });
    expect(sleep).toHaveBeenCalledTimes(1);

    await adapter.promote("dpl_D1");
    await adapter.rollback("dpl_D0");
    expect(postJson).toHaveBeenNthCalledWith(
      2,
      "/v10/projects/prj_project/promote/dpl_D1",
      undefined,
      undefined,
      undefined,
    );
    expect(postJson).toHaveBeenNthCalledWith(
      3,
      "/v1/projects/prj_project/rollback/dpl_D0",
      undefined,
      undefined,
      undefined,
    );
  });

  it("recovers an ambiguous create only by re-reading the exact identity", async () => {
    const exact = deployment({
      meta: {
        releaseCommit: COMMIT_SHA,
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestSha256: LIVE_SOURCE_ARTIFACT.sourceManifestSha256,
      },
    });
    const getJson = vi
      .fn<VercelRestTransport["getJson"]>()
      .mockResolvedValueOnce({ deployments: [], pagination: { next: null } })
      .mockResolvedValueOnce({ deployments: [exact], pagination: { next: null } });
    const postJson = vi
      .fn<VercelRestTransport["postJson"]>()
      .mockRejectedValueOnce(new Error("response lost"));
    const adapter = createVercelDeploymentRestAdapter({
      projectId: "prj_project",
      projectName: "game-base",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestArtifact: LIVE_SOURCE_ARTIFACT,
      stagedProductionSafetyVerified: true,
      transport: {
        getJson,
        postJson,
        postBytes: vi.fn().mockResolvedValue(undefined),
      },
      loadSourceFile: async () => LIVE_SOURCE_BYTES,
    });

    await expect(adapter.ensureStagedDeployment()).resolves.toMatchObject({
      deploymentId: "dpl_D1",
      source: "reused",
    });
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("resolves reuse only from one exact project, commit, identity, and manifest match", () => {
    const expected = {
      commitSha: COMMIT_SHA,
      projectId: "prj_project",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestSha256: MANIFEST_SHA256,
    };
    expect(
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: { deployments: [deployment()], pagination: { next: null } },
          },
        ],
      }),
    ).toEqual({
      kind: "reuse",
      deployment: {
        deploymentId: "dpl_D1",
        url: "staged.example.test",
      },
    });
    expect(
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: {
              pagination: { next: null },
              deployments: [
              {
                uid: "dpl_Legacy",
                projectId: "prj_project",
                readyState: "READY",
                target: "production",
              },
              deployment({ projectId: "prj_other" }),
              deployment({
                meta: {
                  ...deployment().meta,
                  sourceManifestSha256: "d".repeat(64),
                },
              }),
              ],
            },
          },
        ],
      }),
    ).toEqual({ kind: "not-found" });
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: {
              deployments: [deployment(), deployment({ uid: "dpl_D2" })],
              pagination: { next: null },
            },
          },
        ],
      }),
    ).toThrow(VercelDeploymentIdentityAmbiguousError);
  });

  it("requires a complete, correctly chained pagination transcript", () => {
    const expected = {
      commitSha: COMMIT_SHA,
      projectId: "prj_project",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestSha256: MANIFEST_SHA256,
    };
    expect(
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: { deployments: [], pagination: { next: 200 } },
          },
          {
            requestUntil: 200,
            response: { deployments: [], pagination: { next: null } },
          },
        ],
      }),
    ).toEqual({ kind: "not-found" });
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: { deployments: [], pagination: { next: 200 } },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: 100,
            response: { deployments: [], pagination: { next: null } },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: { deployments: [], pagination: { next: 200 } },
          },
          {
            requestUntil: 201,
            response: { deployments: [], pagination: { next: null } },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: Array.from({ length: 10 }, (_, index) => ({
          requestUntil: index === 0 ? undefined : index,
          response: {
            deployments: [],
            pagination: { next: index + 1 },
          },
        })),
      }),
    ).toThrow();
  });

  it("ignores legacy records but stops on a malformed exact metadata claim", () => {
    const expected = {
      commitSha: COMMIT_SHA,
      projectId: "prj_project",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestSha256: MANIFEST_SHA256,
    };
    expect(
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: {
              deployments: [{ uid: "dpl_Legacy" }],
              pagination: { next: null },
            },
          },
        ],
      }),
    ).toEqual({ kind: "not-found" });
    expect(() =>
      resolveReusableVercelProductionDeployment({
        expected,
        pages: [
          {
            requestUntil: undefined,
            response: {
              deployments: [deployment({ url: undefined })],
              pagination: { next: null },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts detail only for the exact READY production deployment identity", () => {
    const expected = {
      commitSha: COMMIT_SHA,
      deploymentId: "dpl_D1",
      projectId: "prj_project",
      releaseIdentity: RELEASE_IDENTITY,
      sourceManifestSha256: MANIFEST_SHA256,
    };
    expect(parseReadyVercelProductionDeployment(deployment(), expected)).toEqual({
      deploymentId: "dpl_D1",
      url: "staged.example.test",
    });
    expect(
      parseReadyVercelProductionDeployment(
        deployment({ readyState: "READY", state: undefined }),
        expected,
      ),
    ).toEqual({
      deploymentId: "dpl_D1",
      url: "staged.example.test",
    });
    expect(() =>
      parseReadyVercelProductionDeployment(
        deployment({ state: "BUILDING" }),
        expected,
      ),
    ).toThrow(VercelDeploymentValidationError);
    expect(() =>
      parseReadyVercelProductionDeployment(
        deployment({ target: "preview" }),
        expected,
      ),
    ).toThrow(VercelDeploymentValidationError);
  });

  it("keeps mutation execution structurally disabled until the live runner lands", () => {
    expect(() => createVercelDeploymentRestAdapter()).toThrow(
      VercelDeploymentMutationDisabledError,
    );
  });

  it("never includes request bytes or metadata values in adapter errors", () => {
    const secret = "metadata_secret_must_not_escape";
    const error = (() => {
      try {
        buildCreateVercelDeploymentRequest({
          projectId: "prj_project",
          projectName: "game-base",
          releaseIdentity: secret,
          sourceManifestArtifact: SOURCE_ARTIFACT,
          stagedProductionSafetyVerified: true,
        });
      } catch (reason) {
        return reason;
      }
    })();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });
});

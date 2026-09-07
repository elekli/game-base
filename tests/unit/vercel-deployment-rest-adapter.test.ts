import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizeProductionDeploymentSourceManifest } from "../../scripts/production-deployment-source-manifest";
import { MAX_PRODUCTION_SOURCE_BLOB_BYTES } from "../../scripts/production-deployment-source-manifest";

import {
  VercelDeploymentIdentityAmbiguousError,
  VercelDeploymentMutationDisabledError,
  VercelDeploymentValidationError,
  VercelStagedProductionSafetyUnverifiedError,
  buildCreateVercelDeploymentRequest,
  buildGetVercelDeploymentRequest,
  buildListVercelProductionDeploymentsRequest,
  buildPromoteVercelDeploymentRequest,
  buildRollbackVercelDeploymentRequest,
  buildUploadVercelFileRequest,
  createVercelDeploymentRestAdapter,
  parseReadyVercelProductionDeployment,
  resolveReusableVercelProductionDeployment,
} from "../../scripts/vercel-deployment-rest-adapter";

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
  it("builds fixed bounded, exact-commit read requests", () => {
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
        sha: COMMIT_SHA,
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

  it("cannot create while repository safety remains unverified", () => {
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: SOURCE_ARTIFACT,
      }),
    ).toThrow(VercelStagedProductionSafetyUnverifiedError);
    expect(
      buildCreateVercelDeploymentRequest({
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: SOURCE_ARTIFACT,
        stagedProductionSafetyVerified: true,
      }),
    ).toMatchObject({
      method: "POST",
      path: "/v13/deployments",
      body: { target: "production", meta: { releaseCommit: COMMIT_SHA } },
    });
  });

  it("derives create files, commit, and digest only from a verified canonical artifact", () => {
    const tamperedBytes = Buffer.from(SOURCE_ARTIFACT.canonicalJson);
    tamperedBytes[tamperedBytes.length - 2] ^= 1;
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: {
          ...SOURCE_ARTIFACT,
          canonicalJson: tamperedBytes,
        },
      }),
    ).toThrow();
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: {
          ...SOURCE_ARTIFACT,
          sourceManifestSha256: "d".repeat(64),
        },
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

  it("keeps mutation execution structurally disabled and requires staged safety for pure creation", () => {
    expect(() => createVercelDeploymentRestAdapter()).toThrow(
      VercelDeploymentMutationDisabledError,
    );
    expect(() =>
      buildCreateVercelDeploymentRequest({
        projectName: "game-base",
        releaseIdentity: RELEASE_IDENTITY,
        sourceManifestArtifact: SOURCE_ARTIFACT,
      }),
    ).toThrow(VercelStagedProductionSafetyUnverifiedError);
  });

  it("never includes request bytes or metadata values in adapter errors", () => {
    const secret = "metadata_secret_must_not_escape";
    const error = (() => {
      try {
        buildCreateVercelDeploymentRequest({
          projectName: "game-base",
          releaseIdentity: secret,
          sourceManifestArtifact: SOURCE_ARTIFACT,
        });
      } catch (reason) {
        return reason;
      }
    })();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });
});

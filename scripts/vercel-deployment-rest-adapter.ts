import { createHash } from "node:crypto";

import {
  canonicalizeProductionDeploymentSourceManifest,
  type CanonicalProductionDeploymentSourceManifest,
  parseProductionDeploymentSourceManifest,
  type ProductionDeploymentSourceManifestFile,
  verifyProductionDeploymentSourceFileBytes,
} from "./production-deployment-source-manifest";

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

export class VercelDeploymentRequestContractError extends Error {
  constructor() {
    super("Vercel deployment request contract is invalid.");
    this.name = "VercelDeploymentRequestContractError";
  }
}

export class VercelDeploymentMalformedResponseError extends Error {
  constructor() {
    super("Vercel deployment response did not match the required shape.");
    this.name = "VercelDeploymentMalformedResponseError";
  }
}

export class VercelDeploymentIdentityAmbiguousError extends Error {
  constructor() {
    super("More than one Vercel deployment matched the exact release identity.");
    this.name = "VercelDeploymentIdentityAmbiguousError";
  }
}

export class VercelDeploymentValidationError extends Error {
  constructor() {
    super("Vercel deployment did not match the required production identity.");
    this.name = "VercelDeploymentValidationError";
  }
}

export class VercelDeploymentMutationDisabledError extends Error {
  constructor() {
    super("Live Vercel deployment mutations are disabled.");
    this.name = "VercelDeploymentMutationDisabledError";
  }
}

export class VercelStagedProductionSafetyUnverifiedError extends Error {
  constructor() {
    super("Staged Production deployment safety has not been verified.");
    this.name = "VercelStagedProductionSafetyUnverifiedError";
  }
}

type GetRequest = Readonly<{
  method: "GET";
  path: string;
  query?: Readonly<Record<string, string>>;
}>;

type PostRequest<TBody = undefined> = Readonly<{
  method: "POST";
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: TBody;
}>;

type DeploymentIdentity = Readonly<{
  commitSha: string;
  projectId: string;
  releaseIdentity: string;
  sourceManifestSha256: string;
}>;

type ResolvedDeployment = Readonly<{
  deploymentId: string;
  url: string;
}>;

type ParsedDeployment = ResolvedDeployment &
  DeploymentIdentity &
  Readonly<{
    state: string;
    target: string;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReleaseIdentity(commitSha: string, releaseIdentity: string) {
  return releaseIdentity === `production:${commitSha}`;
}

function validateIdentity(identity: DeploymentIdentity) {
  if (
    !FULL_SHA.test(identity.commitSha) ||
    !PROJECT_ID.test(identity.projectId) ||
    !validReleaseIdentity(identity.commitSha, identity.releaseIdentity) ||
    !SHA256.test(identity.sourceManifestSha256)
  ) {
    throw new VercelDeploymentRequestContractError();
  }
}

export function buildListVercelProductionDeploymentsRequest({
  commitSha,
  projectId,
  until,
}: Readonly<{
  commitSha: string;
  projectId: string;
  until?: number;
}>): GetRequest {
  if (
    !FULL_SHA.test(commitSha) ||
    !PROJECT_ID.test(projectId) ||
    (until !== undefined &&
      (!Number.isSafeInteger(until) || until < 0))
  ) {
    throw new VercelDeploymentRequestContractError();
  }
  return {
    method: "GET",
    path: "/v7/deployments",
    query: {
      limit: String(PAGE_LIMIT),
      projectId,
      sha: commitSha,
      target: "production",
      ...(until === undefined ? {} : { until: String(until) }),
    },
  };
}

export function buildGetVercelDeploymentRequest(idOrUrl: string): GetRequest {
  if (
    idOrUrl.trim().length === 0 ||
    idOrUrl !== idOrUrl.trim() ||
    idOrUrl.length > 253 ||
    /[\u0000-\u001f\u007f]/.test(idOrUrl)
  ) {
    throw new VercelDeploymentRequestContractError();
  }
  return {
    method: "GET",
    path: `/v13/deployments/${encodeURIComponent(idOrUrl)}`,
  };
}

export function buildUploadVercelFileRequest(
  input: Uint8Array,
  expectedFile: ProductionDeploymentSourceManifestFile,
): PostRequest<Buffer> {
  if (!isRecord(expectedFile)) {
    throw new VercelDeploymentRequestContractError();
  }
  verifyProductionDeploymentSourceFileBytes(
    expectedFile as ProductionDeploymentSourceManifestFile,
    input,
  );
  const body = Buffer.from(input);
  return {
    method: "POST",
    path: "/v2/files",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/octet-stream",
      "x-vercel-digest": createHash("sha1").update(body).digest("hex"),
    },
    body,
  };
}

export function buildCreateVercelDeploymentRequest(input: Readonly<{
  projectName: string;
  releaseIdentity: string;
  sourceManifestArtifact: CanonicalProductionDeploymentSourceManifest;
}>): never {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, "projectName") ||
    !Object.hasOwn(input, "releaseIdentity") ||
    !Object.hasOwn(input, "sourceManifestArtifact")
  ) {
    throw new VercelDeploymentRequestContractError();
  }
  const { projectName, releaseIdentity, sourceManifestArtifact } = input;
  const verifiedSource = verifyCanonicalSourceManifestArtifact(
    sourceManifestArtifact,
  );
  const { commitSha } = verifiedSource.manifest;
  if (
    projectName.trim().length === 0 ||
    projectName !== projectName.trim() ||
    projectName.length > 100 ||
    !FULL_SHA.test(commitSha) ||
    !validReleaseIdentity(commitSha, releaseIdentity)
  ) {
    throw new VercelDeploymentRequestContractError();
  }
  throw new VercelStagedProductionSafetyUnverifiedError();
}

function verifyCanonicalSourceManifestArtifact(
  value: unknown,
): CanonicalProductionDeploymentSourceManifest {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "manifest") ||
    !Object.hasOwn(value, "canonicalJson") ||
    !Object.hasOwn(value, "sourceManifestSha256") ||
    Object.keys(value).length !== 3 ||
    !(value.canonicalJson instanceof Uint8Array) ||
    typeof value.sourceManifestSha256 !== "string" ||
    !SHA256.test(value.sourceManifestSha256)
  ) {
    throw new VercelDeploymentRequestContractError();
  }
  try {
    const parsed = parseProductionDeploymentSourceManifest(
      value.canonicalJson,
    );
    const declared = canonicalizeProductionDeploymentSourceManifest(
      value.manifest as CanonicalProductionDeploymentSourceManifest["manifest"],
    );
    const calculated = canonicalizeProductionDeploymentSourceManifest(parsed);
    if (
      !declared.canonicalJson.equals(calculated.canonicalJson) ||
      value.sourceManifestSha256 !== calculated.sourceManifestSha256
    ) {
      throw new VercelDeploymentRequestContractError();
    }
    return calculated;
  } catch (error) {
    if (error instanceof VercelDeploymentRequestContractError) throw error;
    throw new VercelDeploymentRequestContractError();
  }
}

function validateMutationIds(projectId: string, deploymentId: string) {
  if (!PROJECT_ID.test(projectId) || !DEPLOYMENT_ID.test(deploymentId)) {
    throw new VercelDeploymentRequestContractError();
  }
}

export function buildPromoteVercelDeploymentRequest({
  deploymentId,
  projectId,
}: Readonly<{ deploymentId: string; projectId: string }>): PostRequest {
  validateMutationIds(projectId, deploymentId);
  return {
    method: "POST",
    path: `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
  };
}

export function buildRollbackVercelDeploymentRequest({
  deploymentId,
  projectId,
}: Readonly<{ deploymentId: string; projectId: string }>): PostRequest {
  validateMutationIds(projectId, deploymentId);
  return {
    method: "POST",
    path: `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`,
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new VercelDeploymentMalformedResponseError();
  }
  return value;
}

function parseDeployment(value: unknown): ParsedDeployment {
  if (!isRecord(value) || !isRecord(value.meta)) {
    throw new VercelDeploymentMalformedResponseError();
  }
  const deploymentId =
    typeof value.uid === "string"
      ? value.uid
      : typeof value.id === "string"
        ? value.id
        : undefined;
  const projectId =
    typeof value.projectId === "string"
      ? value.projectId
      : isRecord(value.project) && typeof value.project.id === "string"
        ? value.project.id
        : undefined;
  if (
    deploymentId === undefined ||
    projectId === undefined ||
    !DEPLOYMENT_ID.test(deploymentId) ||
    !PROJECT_ID.test(projectId)
  ) {
    throw new VercelDeploymentMalformedResponseError();
  }
  const state =
    typeof value.readyState === "string"
      ? value.readyState
      : typeof value.state === "string"
        ? value.state
        : undefined;
  if (
    state === undefined ||
    state.length === 0 ||
    (typeof value.readyState === "string" &&
      typeof value.state === "string" &&
      value.readyState !== value.state)
  ) {
    throw new VercelDeploymentMalformedResponseError();
  }
  return {
    deploymentId,
    url: requiredString(value, "url"),
    projectId,
    state,
    target: requiredString(value, "target"),
    commitSha: requiredString(value.meta, "releaseCommit"),
    releaseIdentity: requiredString(value.meta, "releaseIdentity"),
    sourceManifestSha256: requiredString(value.meta, "sourceManifestSha256"),
  };
}

function matchesIdentity(
  deployment: ParsedDeployment,
  expected: DeploymentIdentity,
) {
  return (
    deployment.projectId === expected.projectId &&
    deployment.target === "production" &&
    deployment.commitSha === expected.commitSha &&
    deployment.releaseIdentity === expected.releaseIdentity &&
    deployment.sourceManifestSha256 === expected.sourceManifestSha256
  );
}

export function resolveReusableVercelProductionDeployment({
  expected,
  pages,
}: Readonly<{
  expected: DeploymentIdentity;
  pages: ReadonlyArray<unknown>;
}>):
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "reuse"; deployment: ResolvedDeployment }> {
  validateIdentity(expected);
  if (pages.length === 0 || pages.length > MAX_PAGES) {
    throw new VercelDeploymentMalformedResponseError();
  }
  const matches: ParsedDeployment[] = [];
  let expectedRequestUntil: number | undefined;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (
      !isRecord(page) ||
      page.requestUntil !== expectedRequestUntil ||
      !isRecord(page.response) ||
      !Array.isArray(page.response.deployments) ||
      page.response.deployments.length > PAGE_LIMIT ||
      !isRecord(page.response.pagination) ||
      !Object.hasOwn(page.response.pagination, "next")
    ) {
      throw new VercelDeploymentMalformedResponseError();
    }
    const next = page.response.pagination.next;
    if (
      next !== null &&
      (!Number.isSafeInteger(next) || (next as number) < 0)
    ) {
      throw new VercelDeploymentMalformedResponseError();
    }
    const isLastPage = pageIndex === pages.length - 1;
    if ((isLastPage && next !== null) || (!isLastPage && next === null)) {
      throw new VercelDeploymentMalformedResponseError();
    }
    expectedRequestUntil = next === null ? undefined : (next as number);
    for (const value of page.response.deployments) {
      if (!isRecord(value)) {
        throw new VercelDeploymentMalformedResponseError();
      }
      const metadata = isRecord(value.meta) ? value.meta : undefined;
      if (
        metadata?.releaseCommit !== expected.commitSha ||
        metadata.releaseIdentity !== expected.releaseIdentity ||
        metadata.sourceManifestSha256 !== expected.sourceManifestSha256
      ) {
        continue;
      }
      const candidate = parseDeployment(value);
      if (matchesIdentity(candidate, expected)) matches.push(candidate);
    }
  }
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) throw new VercelDeploymentIdentityAmbiguousError();
  return {
    kind: "reuse",
    deployment: {
      deploymentId: matches[0]!.deploymentId,
      url: matches[0]!.url,
    },
  };
}

export function parseReadyVercelProductionDeployment(
  value: unknown,
  expected: DeploymentIdentity & Readonly<{ deploymentId: string }>,
): ResolvedDeployment {
  validateIdentity(expected);
  if (!DEPLOYMENT_ID.test(expected.deploymentId)) {
    throw new VercelDeploymentRequestContractError();
  }
  const deployment = parseDeployment(value);
  if (
    deployment.deploymentId !== expected.deploymentId ||
    deployment.state !== "READY" ||
    !matchesIdentity(deployment, expected)
  ) {
    throw new VercelDeploymentValidationError();
  }
  return { deploymentId: deployment.deploymentId, url: deployment.url };
}

export function createVercelDeploymentRestAdapter(): never {
  throw new VercelDeploymentMutationDisabledError();
}

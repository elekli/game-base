import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { deploymentBindings } from "../src/shared/config/deployment-bindings";

const SHA256 = /^[a-f0-9]{64}$/;

class ProductionRestoreError extends Error {
  constructor(name: string, readonly safeDetail: string) {
    super(`${name}: ${safeDetail}`);
    this.name = name;
  }
}

export class ProductionRestoreInvalidTransitionError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreInvalidTransitionError", safeDetail);
  }
}

export class ProductionRestoreSourceBindingError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreSourceBindingError", safeDetail);
  }
}

export class ProductionRestoreTargetNotIsolatedError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreTargetNotIsolatedError", safeDetail);
  }
}

export class ProductionRestoreArtifactProtectionError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreArtifactProtectionError", safeDetail);
  }
}

export class ProductionRestoreVerificationError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreVerificationError", safeDetail);
  }
}

export class ProductionRestoreCleanupError extends ProductionRestoreError {
  constructor(safeDetail: string) {
    super("ProductionRestoreCleanupError", safeDetail);
  }
}

export type ProductionRestoreSourceInput = Readonly<{
  kind: "bound-production-direct" | "bound-production-session-pooler";
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: "verify-full";
  caPath: string;
}>;

export type ProductionRestoreSource = ProductionRestoreSourceInput &
  Readonly<{ bindingFingerprint: string }>;

export function calculateProductionRestoreSourceBindingFingerprint(
  source: ProductionRestoreSourceInput,
): string {
  const canonical = JSON.stringify([
    source.kind,
    source.host,
    source.port,
    source.database,
    source.user,
    source.sslMode,
    source.caPath,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type ProductionRestoreLocalTarget = Readonly<{
  host: "127.0.0.1";
  port: number;
  database: string;
  user: string;
}>;

export const PRODUCTION_RESTORE_LOCAL_TARGET: ProductionRestoreLocalTarget =
  Object.freeze({
    host: "127.0.0.1",
    port: 55_432,
    database: "postgres",
    user: "postgres",
  });

export type ProductionRestoreAction =
  | Readonly<{
      kind: "dump-source";
      program: "pg_dump";
      argv: ReadonlyArray<string>;
      environment: Readonly<{ PGSSLMODE: "verify-full"; PGSSLROOTCERT: string }>;
      outputPath: string;
      outputMode: 384;
    }>
  | Readonly<{ kind: "create-local-target"; program: "supabase"; argv: ReadonlyArray<string> }>
  | Readonly<{ kind: "replay-migrations"; program: "supabase"; argv: ReadonlyArray<string> }>
  | Readonly<{ kind: "clear-local-target-data"; program: "psql"; argv: ReadonlyArray<string> }>
  | Readonly<{
      kind: "restore-dump";
      program: "pg_restore";
      argv: ReadonlyArray<string>;
      expectedSha256: string;
    }>
  | Readonly<{ kind: "verify-integrity"; program: "integrity-check"; argv: ReadonlyArray<string> }>
  | Readonly<{ kind: "drop-local-target"; program: "supabase"; argv: ReadonlyArray<string> }>
  | Readonly<{ kind: "delete-dump"; program: "unlink"; argv: ReadonlyArray<string> }>
  | Readonly<{ kind: "stop" }>;

export type ProductionRestoreExecutorResult =
  | Readonly<{
      outcome: "passed";
      byteLength?: number;
      sha256?: string;
      restoredSha256?: string;
      integrityChecks?: number;
    }>
  | Readonly<{ outcome: "failed"; safeDetail: string }>;

export type ProductionRestoreLocalExecutor = Readonly<{
  kind: "fake-local" | "isolated-local";
  execute(action: Exclude<ProductionRestoreAction, { kind: "stop" }>): Promise<ProductionRestoreExecutorResult>;
}>;

type RestorePhase =
  | "dumping"
  | "creating-local-target"
  | "replaying-migrations"
  | "clearing-local-target-data"
  | "restoring"
  | "verifying-integrity"
  | "cleaning-target"
  | "cleaning-dump"
  | "succeeded"
  | "failed";

type TargetOwnership = "not-owned" | "owned-by-this-drill";

type RestoreEvidence = Readonly<{
  outcome: "passed";
  dumpByteLength: number;
  dumpSha256: string;
  integrityChecks: number;
  targetCleaned: true;
  dumpCleaned: true;
  storageBinariesIncluded: false;
}>;

export type ProductionRestoreDrill = Readonly<{
  phase: RestorePhase;
  sourceKind: ProductionRestoreSource["kind"];
  source: ProductionRestoreSource;
  target: ProductionRestoreLocalTarget;
  runnerTempDir: string;
  dumpPath: string;
  next: ProductionRestoreAction;
  targetOwnership: TargetOwnership;
  storageBinariesIncluded: false;
  dumpByteLength?: number;
  dumpSha256?: string;
  integrityChecks?: number;
  primaryFailure?: ProductionRestoreVerificationError;
  cleanupFailure?: ProductionRestoreCleanupError;
  failure?: ProductionRestoreVerificationError;
  evidence?: RestoreEvidence;
}>;

export type ProductionRestoreInput = Readonly<{
  source: ProductionRestoreSourceInput;
  runnerTempDir: string;
  runnerTempMode: number;
  dumpPath: string;
  dumpMode: number;
  publishedArtifactPath?: string;
}>;

function createLocalTargetArgv(runnerTempDir: string): string[] {
  return [
    "start",
    "--workdir",
    runnerTempDir,
    "--exclude",
    "studio,imgproxy,realtime,gotrue,mailpit,postgres-meta,edge-runtime,logflare,vector,supavisor",
  ];
}

function replayMigrationsArgv(runnerTempDir: string): string[] {
  return [
    "db",
    "reset",
    "--workdir",
    runnerTempDir,
    "--no-seed",
  ];
}

function restoreDumpArgv(dumpPath: string): string[] {
  return [
    "--host",
    PRODUCTION_RESTORE_LOCAL_TARGET.host,
    "--port",
    String(PRODUCTION_RESTORE_LOCAL_TARGET.port),
    "--username",
    PRODUCTION_RESTORE_LOCAL_TARGET.user,
    "--dbname",
    PRODUCTION_RESTORE_LOCAL_TARGET.database,
    "--data-only",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    dumpPath,
  ];
}

function clearLocalTargetDataArgv(): string[] {
  return [
    "--host", PRODUCTION_RESTORE_LOCAL_TARGET.host,
    "--port", String(PRODUCTION_RESTORE_LOCAL_TARGET.port),
    "--username", PRODUCTION_RESTORE_LOCAL_TARGET.user,
    "--dbname", PRODUCTION_RESTORE_LOCAL_TARGET.database,
    "--set", "ON_ERROR_STOP=1",
  ];
}

function verifyIntegrityArgv(): string[] {
  return [
    "--host",
    PRODUCTION_RESTORE_LOCAL_TARGET.host,
    "--port",
    String(PRODUCTION_RESTORE_LOCAL_TARGET.port),
    "--username",
    PRODUCTION_RESTORE_LOCAL_TARGET.user,
    "--dbname",
    PRODUCTION_RESTORE_LOCAL_TARGET.database,
  ];
}

function dropLocalTargetArgv(runnerTempDir: string): string[] {
  return [
    "stop",
    "--no-backup",
    "--workdir",
    runnerTempDir,
  ];
}

function validateInput(input: ProductionRestoreInput): void {
  const source = input.source;
  const productionBinding = deploymentBindings.production;
  const directHost = `db.${productionBinding.projectRef}.supabase.co`;
  const directUserAllowed = source.user === "postgres" || source.user === "app_migrator";
  const sessionUserAllowed =
    source.user === `postgres.${productionBinding.projectRef}` ||
    source.user === `app_migrator.${productionBinding.projectRef}`;
  const directSourceAllowed =
    source.kind === "bound-production-direct" &&
    source.host === directHost &&
    directUserAllowed;
  const sessionSourceAllowed =
    source.kind === "bound-production-session-pooler" &&
    source.host === productionBinding.supavisorHost &&
    sessionUserAllowed;
  if (
    (!(directSourceAllowed || sessionSourceAllowed)) ||
    source.port !== 5432 ||
    source.database !== productionBinding.databaseName ||
    source.sslMode !== "verify-full" ||
    source.caPath.trim() === "" ||
    "bindingFingerprint" in source ||
    "expectedSourceBindingFingerprint" in input
  ) {
    throw new ProductionRestoreSourceBindingError(
      "source must be the exact bound Production direct or 5432 session-pooler endpoint with verify-full and a CA",
    );
  }
  if ("target" in input) {
    throw new ProductionRestoreTargetNotIsolatedError(
      "restore target is module-owned and cannot be supplied by the caller",
    );
  }
  const temp = resolve(input.runnerTempDir);
  const dump = resolve(input.dumpPath);
  const dumpRelative = relative(temp, dump);
  const dumpIsInsideTemp = dumpRelative !== "" && !dumpRelative.startsWith("..") && !isAbsolute(dumpRelative);
  if (
    !isAbsolute(input.runnerTempDir) ||
    !isAbsolute(input.dumpPath) ||
    !dumpIsInsideTemp ||
    input.runnerTempMode !== 0o700 ||
    input.dumpMode !== 0o600 ||
    input.publishedArtifactPath !== undefined
  ) {
    throw new ProductionRestoreArtifactProtectionError(
      "dump must stay inside a 0700 runner directory as a 0600 non-published artifact",
    );
  }
}

function dumpAction(
  source: ProductionRestoreSource,
  dumpPath: string,
): ProductionRestoreAction {
  return {
    kind: "dump-source",
    program: "pg_dump",
    argv: [
      "--host",
      source.host,
      "--port",
      String(source.port),
      "--username",
      source.user,
      "--dbname",
      source.database,
      "--format=custom",
      "--data-only",
      "--schema=app_private",
      "--no-owner",
      "--no-privileges",
      "--file",
      dumpPath,
    ],
    environment: { PGSSLMODE: "verify-full", PGSSLROOTCERT: source.caPath },
    outputPath: dumpPath,
    outputMode: 0o600,
  };
}

export function createProductionRestoreDrill(input: ProductionRestoreInput): ProductionRestoreDrill {
  validateInput(input);
  const source: ProductionRestoreSource = Object.freeze({
    ...input.source,
    bindingFingerprint:
      calculateProductionRestoreSourceBindingFingerprint(input.source),
  });
  return {
    phase: "dumping",
    sourceKind: source.kind,
    source,
    target: PRODUCTION_RESTORE_LOCAL_TARGET,
    runnerTempDir: input.runnerTempDir,
    dumpPath: input.dumpPath,
    next: dumpAction(source, input.dumpPath),
    targetOwnership: "not-owned",
    storageBinariesIncluded: false,
  };
}

function cleanupDump(
  drill: ProductionRestoreDrill,
  primaryFailure?: ProductionRestoreVerificationError,
): ProductionRestoreDrill {
  return {
    ...drill,
    phase: "cleaning-dump",
    primaryFailure,
    next: { kind: "delete-dump", program: "unlink", argv: [drill.dumpPath] },
  };
}

function cleanupTarget(
  drill: ProductionRestoreDrill,
  primaryFailure?: ProductionRestoreVerificationError,
): ProductionRestoreDrill {
  if (drill.targetOwnership !== "owned-by-this-drill") {
    throw new ProductionRestoreInvalidTransitionError(
      "cannot drop a restore target without ownership from this drill",
    );
  }
  return {
    ...drill,
    phase: "cleaning-target",
    primaryFailure,
    next: { kind: "drop-local-target", program: "supabase", argv: dropLocalTargetArgv(drill.runnerTempDir) },
  };
}

function cleanupAfterFailure(
  drill: ProductionRestoreDrill,
  primaryFailure: ProductionRestoreVerificationError,
): ProductionRestoreDrill {
  return drill.targetOwnership === "owned-by-this-drill"
    ? cleanupTarget(drill, primaryFailure)
    : cleanupDump(drill, primaryFailure);
}

function verificationFailure(detail: string): ProductionRestoreVerificationError {
  return new ProductionRestoreVerificationError(detail);
}

function transition(
  drill: ProductionRestoreDrill,
  result: ProductionRestoreExecutorResult,
): ProductionRestoreDrill {
  if (drill.next.kind === "stop") {
    throw new ProductionRestoreInvalidTransitionError("cannot execute after stop");
  }

  if (drill.phase === "cleaning-target") {
    const cleanupFailure =
      result.outcome === "failed"
        ? new ProductionRestoreCleanupError(`target cleanup failed: ${result.safeDetail}`)
        : drill.cleanupFailure;
    return {
      ...drill,
      phase: "cleaning-dump",
      cleanupFailure,
      targetOwnership:
        result.outcome === "failed"
          ? drill.targetOwnership
          : "not-owned",
      next: { kind: "delete-dump", program: "unlink", argv: [drill.dumpPath] },
    };
  }
  if (drill.phase === "cleaning-dump") {
    if (result.outcome === "failed") {
      const prior = drill.cleanupFailure
        ? `${drill.cleanupFailure.safeDetail}; `
        : "";
      throw new ProductionRestoreCleanupError(
        `${prior}dump cleanup failed: ${result.safeDetail}`,
      );
    }
    if (drill.cleanupFailure) {
      throw drill.cleanupFailure;
    }
    if (drill.primaryFailure) {
      return { ...drill, phase: "failed", failure: drill.primaryFailure, next: { kind: "stop" } };
    }
    if (drill.dumpByteLength === undefined || drill.dumpSha256 === undefined || drill.integrityChecks === undefined) {
      throw new ProductionRestoreInvalidTransitionError("successful cleanup is missing verification evidence");
    }
    return {
      ...drill,
      phase: "succeeded",
      next: { kind: "stop" },
      evidence: {
        outcome: "passed",
        dumpByteLength: drill.dumpByteLength,
        dumpSha256: drill.dumpSha256,
        integrityChecks: drill.integrityChecks,
        targetCleaned: true,
        dumpCleaned: true,
        storageBinariesIncluded: false,
      },
    };
  }

  if (result.outcome === "failed") {
    return cleanupAfterFailure(drill, verificationFailure(result.safeDetail));
  }

  switch (drill.phase) {
    case "dumping": {
      if (!Number.isInteger(result.byteLength) || (result.byteLength ?? 0) <= 0 || !result.sha256 || !SHA256.test(result.sha256)) {
        return cleanupDump(drill, verificationFailure("dump is empty or has an invalid digest"));
      }
      return {
        ...drill,
        phase: "creating-local-target",
        dumpByteLength: result.byteLength,
        dumpSha256: result.sha256,
        next: { kind: "create-local-target", program: "supabase", argv: createLocalTargetArgv(drill.runnerTempDir) },
      };
    }
    case "creating-local-target":
      return {
        ...drill,
        phase: "replaying-migrations",
        targetOwnership: "owned-by-this-drill",
        next: { kind: "replay-migrations", program: "supabase", argv: replayMigrationsArgv(drill.runnerTempDir) },
      };
    case "replaying-migrations":
      return {
        ...drill,
        phase: "clearing-local-target-data",
        next: { kind: "clear-local-target-data", program: "psql", argv: clearLocalTargetDataArgv() },
      };
    case "clearing-local-target-data":
      if (!drill.dumpSha256) {
        throw new ProductionRestoreInvalidTransitionError("restore digest is unavailable");
      }
      return {
        ...drill,
        phase: "restoring",
        next: {
          kind: "restore-dump",
          program: "pg_restore",
          argv: restoreDumpArgv(drill.dumpPath),
          expectedSha256: drill.dumpSha256,
        },
      };
    case "restoring":
      if (!result.restoredSha256 || result.restoredSha256 !== drill.dumpSha256) {
        return cleanupTarget(drill, verificationFailure("restored artifact digest does not match the dump"));
      }
      return {
        ...drill,
        phase: "verifying-integrity",
        next: { kind: "verify-integrity", program: "integrity-check", argv: verifyIntegrityArgv() },
      };
    case "verifying-integrity":
      if (!Number.isInteger(result.integrityChecks) || (result.integrityChecks ?? 0) < 1) {
        return cleanupTarget(drill, verificationFailure("integrity verification produced no passing checks"));
      }
      return cleanupTarget({ ...drill, integrityChecks: result.integrityChecks });
    default:
      throw new ProductionRestoreInvalidTransitionError(`result is invalid during ${drill.phase}`);
  }
}

export async function runProductionRestoreDrill(
  initial: ProductionRestoreDrill,
  executor: ProductionRestoreLocalExecutor,
): Promise<ProductionRestoreDrill> {
  if (executor.kind !== "fake-local" && executor.kind !== "isolated-local") {
    throw new ProductionRestoreInvalidTransitionError(
      "restore executor kind is invalid",
    );
  }
  let drill = initial;
  for (let step = 0; step < 12 && drill.next.kind !== "stop"; step += 1) {
    const action = drill.next;
    let result: ProductionRestoreExecutorResult;
    try {
      result = await executor.execute(action);
    } catch {
      result = { outcome: "failed", safeDetail: "fake local executor rejected" };
    }
    drill = transition(drill, result);
  }
  if (drill.next.kind !== "stop") {
    throw new ProductionRestoreInvalidTransitionError("restore drill exceeded its bounded action count");
  }
  return drill;
}

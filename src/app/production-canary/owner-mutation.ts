import "server-only";

import { runProductionProductCanaryCommand } from "@/shared/production-canary/command-context";
import type { ProductionProductCanaryOperation } from "@/adapters/production-product-canary-adapter";
import { productionProductCanary } from "./service";
import { CommandIdempotencyConflictError, CommandVersionConflictError } from "@/modules/commands";
import { NoteVersionConflictError } from "@/modules/notes";

const GENERATION_COOKIE = "production_canary_generation";
const EXECUTION_SHA_COOKIE = "production_canary_execution_sha";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNCERTAIN_DATABASE_OUTCOMES = new Set([
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "ECONNRESET", "ETIMEDOUT",
]);

function isUncertainDatabaseOutcome(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return UNCERTAIN_DATABASE_OUTCOMES.has(error.code) || error.code.startsWith("08");
}

export function productionCanaryGenerationFromCookie(headers: Headers) {
  const cookie = headers.get("cookie") ?? "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${GENERATION_COOKIE}=`));
  if (!entry) return null;
  const generation = entry.slice(GENERATION_COOKIE.length + 1);
  if (!UUID_V4.test(generation)) return null;
  return generation;
}

export function attachProductionCanaryExecutionSha<Value extends object>(headers: Headers, value: Value) {
  const cookie = headers.get("cookie") ?? "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${GENERATION_COOKIE}=`));
  const generation = entry?.slice(GENERATION_COOKIE.length + 1);
  if (!generation) return value;
  if (!UUID_V4.test(generation)) return value;
  const executionSha = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    ...value,
    executionSha: executionSha && /^[a-f0-9]{40}$/.test(executionSha) ? executionSha : null,
  };
}

export async function withProductionProductCanaryMutation<Value>(input: Readonly<{
  headers: Headers;
  ownerId: string;
  commandId: string;
  operation: ProductionProductCanaryOperation;
  targetIds: readonly string[];
  execute: () => Promise<Value>;
}>): Promise<Value> {
  const generation = productionCanaryGenerationFromCookie(input.headers);
  if (!generation) return input.execute();

  const command = {
    generation,
    ownerId: input.ownerId,
    commandId: input.commandId.toLowerCase(),
    operation: input.operation,
    targetIds: input.targetIds.map((id) => id.toLowerCase()),
  } as const;
  if (!UUID_V4.test(command.commandId) || command.targetIds.length < 1 || command.targetIds.length > 2) {
    throw new Error("production canary command is invalid");
  }
  const cookies = (input.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  const expectedSha = cookies.find((part) => part.startsWith(`${EXECUTION_SHA_COOKIE}=`))?.slice(EXECUTION_SHA_COOKIE.length + 1);
  const actualSha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha) || expectedSha !== actualSha) {
    throw new Error("production canary execution SHA does not match the requested release");
  }
  try {
    if (!await productionProductCanary.beginCommand(command)) {
      throw new Error("production canary command was not accepted");
    }
    let result: Value;
    try {
      result = await runProductionProductCanaryCommand(command, input.execute);
    } catch (error) {
      if (error instanceof CommandVersionConflictError || error instanceof CommandIdempotencyConflictError || error instanceof NoteVersionConflictError) throw error;
      if (!isUncertainDatabaseOutcome(error)) throw error;
      // The database may have committed while its response was lost. Replay once with
      // the same command ID and captured payload; the receipt's unique command ID
      // serializes a concurrent attempt and returns the first committed result.
      result = await runProductionProductCanaryCommand(command, input.execute);
    }
    let completed = false;
    let completionError: unknown;
    try {
      completed = await productionProductCanary.completeCommand(generation, command.commandId);
    } catch (error) {
      completionError = error;
    }
    if (!completed) {
      const current = await productionProductCanary.inspect();
      if (current?.generation !== generation) {
        throw new Error("production canary command completion is uncertain", { cause: completionError });
      }
      if (current.phase === "active") {
        if (!await productionProductCanary.beginCommand(command)) {
          throw new Error("production canary receipt replay could not start", { cause: completionError });
        }
      } else if (current.phase !== "request_pending" || current.commandId !== command.commandId) {
        throw new Error("production canary command completion is uncertain", { cause: completionError });
      }
      // A successful commit may have lost its completion response. Reopen the same
      // idempotency key, replay the captured payload, and complete the receipt again.
      result = await runProductionProductCanaryCommand(command, input.execute);
      if (!await productionProductCanary.completeCommand(generation, command.commandId)) {
        throw new Error("production canary receipt replay completion is uncertain");
      }
    }
    return result;
  } catch (error) {
    if (error instanceof CommandVersionConflictError || error instanceof CommandIdempotencyConflictError || error instanceof NoteVersionConflictError) {
      if (!await productionProductCanary.completeCommand(generation, command.commandId)) {
        throw new Error("production canary conflict completion is uncertain", { cause: error });
      }
      throw error;
    }
    // Keep request_pending on uncertain failures. The protected runner waits for the
    // database deadline before it can mark recovery and clean up this exact command.
    throw error;
  }
}

export function productionCanaryNoteMutationTarget(input: Readonly<{ gameId?: string; noteId?: string }>) {
  const target = input.gameId ?? input.noteId;
  if (!target) throw new Error("production canary note target is missing");
  return target;
}

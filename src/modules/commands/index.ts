import { createHash } from "node:crypto";

import { NamedError } from "@/shared/errors/named-error";

export const COMMAND_RECEIPT_RETENTION_DAYS = 90;

export type CommandResourceState = "active" | "trashed";

export type GameEditCommand = Readonly<{
  ownerId: string;
  commandId: string;
  expectedVersion: number;
  gameId: string;
  payload: Readonly<{
    displayName?: string | null;
    actualPlatforms?: readonly string[];
    tags?: readonly string[];
    playerCountNote?: string | null;
  }>;
}>;

function uniqueNames(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const displayName = value.trim();
    const key = displayName.toLocaleLowerCase("en-US");
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(displayName);
    }
  }
  return result;
}

export function normalizeGameEditPayload(payload: GameEditCommand["payload"]): GameEditCommand["payload"] {
  return {
    ...(payload.displayName !== undefined
      ? { displayName: payload.displayName === null ? null : payload.displayName.trim() || null }
      : {}),
    ...(payload.actualPlatforms !== undefined ? { actualPlatforms: uniqueNames(payload.actualPlatforms) } : {}),
    ...(payload.tags !== undefined ? { tags: uniqueNames(payload.tags) } : {}),
    ...(payload.playerCountNote !== undefined
      ? { playerCountNote: payload.playerCountNote === null ? null : payload.playerCountNote.trim() || null }
      : {}),
  };
}

export type VersionedCommandResult = Readonly<{
  resourceId: string;
  version: number;
  state: CommandResourceState;
  replayed: boolean;
}>;

export class CommandVersionConflictError extends NamedError {
  constructor(
    readonly currentVersion: number,
    readonly currentState: CommandResourceState,
  ) {
    super("command_version_conflict", "資料已在其他操作中更新，請先載入最新版本。");
    this.name = "CommandVersionConflictError";
  }
}

export class CommandIdempotencyConflictError extends NamedError {
  constructor() {
    super("command_idempotency_conflict", "這次操作的識別碼已用於不同內容，請重新操作。");
    this.name = "CommandIdempotencyConflictError";
  }
}

export class CommandTargetNotFoundError extends NamedError {
  constructor() {
    super("command_target_not_found", "找不到要更新的資料，請重新載入。");
    this.name = "CommandTargetNotFoundError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function commandPayloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

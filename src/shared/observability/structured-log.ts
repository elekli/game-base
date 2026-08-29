import { z } from "zod";

const logEventSchema = z.object({
  event: z.string().min(1),
  level: z.enum(["info", "warn", "error"]),
  requestId: z.uuid(),
  operation: z.string().min(1),
  errorCode: z.string().nullable(),
  resourceType: z
    .enum(["game", "note", "list", "media", "external_identity", "refresh_run"])
    .nullable(),
  resourceId: z.uuid().nullable(),
  attempt: z.number().int().nonnegative().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  environment: z.enum(["preview", "production"]),
});

const bootstrapLogEventSchema = logEventSchema.omit({ environment: true });

export type StructuredLogInput = z.input<typeof logEventSchema> &
  Readonly<Record<string, unknown>>;

export function serializeLogEvent(input: StructuredLogInput): string {
  return JSON.stringify(logEventSchema.parse(input));
}

export type BootstrapLogInput = z.input<typeof bootstrapLogEventSchema> &
  Readonly<Record<string, unknown>>;

export function serializeBootstrapLogEvent(input: BootstrapLogInput): string {
  return JSON.stringify(bootstrapLogEventSchema.parse(input));
}

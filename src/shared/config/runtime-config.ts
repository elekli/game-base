import { createHash } from "node:crypto";
import { z } from "zod";
import { NamedError } from "@/shared/errors/named-error";
import { deploymentBindings } from "./deployment-bindings";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const environmentSchema = z.object({
  VERCEL_ENV: z.enum(["development", "preview", "production"]),
  EXPECTED_VERCEL_ENV: z.enum(["development", "preview", "production"]),
  SUPABASE_PROJECT_REF: z.string().min(1),
  EXPECTED_SUPABASE_PROJECT_REF: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().startsWith("sb_publishable_"),
  SUPABASE_SECRET_KEY: z.string().startsWith("sb_secret_"),
  EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256: z.string().regex(SHA256_PATTERN),
  EXPECTED_SUPABASE_SECRET_KEY_SHA256: z.string().regex(SHA256_PATTERN),
  SUPAVISOR_HOST: z.string().min(1),
  EXPECTED_SUPAVISOR_HOST: z.string().min(1),
  SUPAVISOR_PORT: z.enum(["54329", "6543"]),
  SUPAVISOR_USERNAME: z.string().min(1),
  EXPECTED_SUPAVISOR_USERNAME: z.string().min(1),
  DATABASE_URL: z.url(),
  CLOUDFLARE_ACCESS_ISSUER: z.url(),
  CLOUDFLARE_ACCESS_AUDIENCE: z.string().min(1),
  CLOUDFLARE_ACCESS_JWKS_URL: z.url(),
  OWNER_EMAIL: z.email(),
  OWNER_SUB: z.string().trim().min(1),
});

export class RuntimeConfigError extends NamedError {
  constructor() {
    super("runtime_config_invalid", "部署環境設定不一致。");
    this.name = "RuntimeConfigError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertEqual(actual: unknown, expected: unknown): asserts actual {
  if (actual !== expected) throw new RuntimeConfigError();
}

export function parseRuntimeConfig(
  input: Readonly<Record<string, string | undefined>>,
) {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) throw new RuntimeConfigError();
  const env = parsed.data;

  const supabaseUrl = new URL(env.SUPABASE_URL);
  const databaseUrl = new URL(env.DATABASE_URL);
  const issuer = new URL(env.CLOUDFLARE_ACCESS_ISSUER);
  const jwksUrl = new URL(env.CLOUDFLARE_ACCESS_JWKS_URL);

  assertEqual(env.VERCEL_ENV, env.EXPECTED_VERCEL_ENV);
  assertEqual(env.SUPABASE_PROJECT_REF, env.EXPECTED_SUPABASE_PROJECT_REF);
  if (env.VERCEL_ENV === "development") {
    assertEqual(["127.0.0.1", "localhost"].includes(supabaseUrl.hostname), true);
    assertEqual(env.SUPAVISOR_PORT, "54329");
  } else {
    const binding = deploymentBindings[env.VERCEL_ENV];
    assertEqual(env.SUPABASE_PROJECT_REF, binding.projectRef);
    assertEqual(env.EXPECTED_SUPABASE_PROJECT_REF, binding.projectRef);
    assertEqual(env.SUPAVISOR_HOST, binding.supavisorHost);
    assertEqual(env.EXPECTED_SUPAVISOR_HOST, binding.supavisorHost);
    assertEqual(env.SUPAVISOR_USERNAME, binding.supavisorUsername);
    assertEqual(env.EXPECTED_SUPAVISOR_USERNAME, binding.supavisorUsername);
    assertEqual(env.EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256, binding.publishableKeySha256);
    assertEqual(env.EXPECTED_SUPABASE_SECRET_KEY_SHA256, binding.secretKeySha256);
    assertEqual(supabaseUrl.hostname, `${env.SUPABASE_PROJECT_REF}.supabase.co`);
    assertEqual(env.SUPAVISOR_PORT, "6543");
  }
  assertEqual(env.SUPAVISOR_HOST, env.EXPECTED_SUPAVISOR_HOST);
  assertEqual(env.SUPAVISOR_USERNAME, env.EXPECTED_SUPAVISOR_USERNAME);
  assertEqual(databaseUrl.hostname, env.SUPAVISOR_HOST);
  assertEqual(databaseUrl.port, env.SUPAVISOR_PORT);
  assertEqual(decodeURIComponent(databaseUrl.username), env.SUPAVISOR_USERNAME);
  assertEqual(databaseUrl.protocol === "postgres:" || databaseUrl.protocol === "postgresql:", true);
  assertEqual(
    sha256(env.SUPABASE_PUBLISHABLE_KEY),
    env.EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256,
  );
  assertEqual(sha256(env.SUPABASE_SECRET_KEY), env.EXPECTED_SUPABASE_SECRET_KEY_SHA256);
  assertEqual(jwksUrl.origin, issuer.origin);

  return {
    environment: env.VERCEL_ENV,
    databaseUrl: env.DATABASE_URL,
    cloudflare: {
      audience: env.CLOUDFLARE_ACCESS_AUDIENCE,
      issuer: env.CLOUDFLARE_ACCESS_ISSUER,
      jwksUrl: env.CLOUDFLARE_ACCESS_JWKS_URL,
      ownerEmail: env.OWNER_EMAIL,
      ownerSub: env.OWNER_SUB,
    },
    supabase: {
      projectRef: env.SUPABASE_PROJECT_REF,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
      url: env.SUPABASE_URL,
    },
    supavisor: {
      host: env.SUPAVISOR_HOST,
      port: Number(env.SUPAVISOR_PORT),
      username: env.SUPAVISOR_USERNAME,
    },
  } as const;
}

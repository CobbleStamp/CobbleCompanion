import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { McpWhitelistEntry, RedactionMode } from '@cobble/core';
import { DEFAULT_STARTING_VITALITY_TOKENS } from '@cobble/db';
import { z } from 'zod';

/**
 * True when two filesystem paths are the same directory or one is nested inside
 * the other (after resolving to absolute). Used to fail-fast a config where the
 * read-only CLI tool dir overlaps a path the app writes to — a writable tools dir
 * lets anyone who can write there admit a binary the companion will run
 * (companion-tools.md §6; the constraint the .env.example warns about).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const ra: string = resolve(a);
  const rb: string = resolve(b);
  if (ra === rb) return true;
  const nested = (rel: string): boolean =>
    rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  return nested(relative(ra, rb)) || nested(relative(rb, ra));
}

/**
 * Authentication mode. `google` (default) gates the app behind Google Sign-In:
 * the SPA obtains a Google ID token and the API verifies it as a bearer JWT
 * against Google's JWKS. `dev_bypass` skips Google entirely so the app can run
 * locally and in tests with no live provider. `service_token` is server-to-server:
 * a trusted backend consumer authenticates with a `(client_id, secret)` pair validated
 * against the `service_registry` table and names the acting user via an `X-User-Id`
 * header (no env secret — the registry is the source of truth). Default is `google`,
 * so production is never accidentally open.
 */
export type AuthMode = 'google' | 'dev_bypass' | 'service_token';

/**
 * Runtime configuration (implementation.md §3). Required secrets are validated at
 * startup — fail fast (security.md). Tests construct an AppConfig directly.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly llmProvider: 'openrouter' | 'fake';
  readonly openrouterApiKey: string;
  readonly llmModel: string;
  readonly embeddingProvider: 'openrouter' | 'fake';
  readonly embeddingModel: string;
  /** Must equal the `sections.embedding` vector column dimension (db schema). */
  readonly embeddingDimensions: number;
  /** Cheap model for the two ingestion reading passes (input-heavy, output-bounded). */
  readonly ingestionModel: string;
  /** Upload size cap for source files. */
  readonly ingestionMaxBytes: number;
  /** A/B knob: prefix the Pass-2 context header onto embedding inputs. */
  readonly useContextHeader: boolean;
  /** Backstop cap on queued+in-flight ingestion runs across all owners. */
  readonly ingestionQueueMax: number;
  /**
   * The token balance a new companion is seeded with in **each** vitality wallet
   * (stamina + energy). Not a cap — wallets only refill by feeding (architecture.md §4.8).
   */
  readonly startingVitalityTokens: number;
  /**
   * The developer's MCP server whitelist (companion-tools.md §6) — the entire MCP
   * trust decision. Parsed from `MCP_SERVERS` (a JSON array). Empty (default) leaves
   * runtime tool acquisition off, so behaviour is unchanged unless servers are listed.
   */
  readonly mcpServers: readonly McpWhitelistEntry[];
  /** Max tools a companion may carry equipped at once; the LRU evicts beyond it
   *  (companion-tools.md §4). Only meaningful when tool acquisition is configured. */
  readonly maxEquippedTools: number;
  /**
   * Directory of CLI tool-definition folders (companion-tools.md §6) — the CLI
   * trust boundary. Each subfolder (`TOOL.md` + `TOOL.json`) is one whitelisted
   * tool. Must be **read-only + deployment-controlled** and must NOT overlap any
   * path the app writes to. Empty (default) leaves the CLI track off.
   */
  readonly cliToolsPath: string;
  /**
   * Root for the per-tenant ephemeral working directories CLI runs execute in
   * (separate from `cliToolsPath`). Empty → the OS temp dir.
   */
  readonly cliScratchDir: string;
  readonly appUrl: string;
  readonly authMode: AuthMode;
  readonly googleClientId: string;
  readonly devBypassEmail: string;
  readonly port: number;
  readonly isProduction: boolean;
  // Online tracing (Phase C, runbook-tracing.md). Default OFF + strict + 0-rate,
  // so enabling it (a third-party export) is always a deliberate act.
  readonly tracingProvider: 'none' | 'langfuse';
  readonly langfusePublicKey: string;
  readonly langfuseSecretKey: string;
  readonly langfuseHost: string;
  readonly tracingSampleRate: number;
  readonly tracingRedact: RedactionMode;
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    LLM_PROVIDER: z.enum(['openrouter', 'fake']).default('openrouter'),
    OPENROUTER_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
    EMBEDDING_PROVIDER: z.enum(['openrouter', 'fake']).default('openrouter'),
    EMBEDDING_MODEL: z.string().default('perplexity/pplx-embed-v1-0.6b'),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
    INGESTION_MODEL: z.string().default('google/gemini-2.5-flash'),
    INGESTION_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    USE_CONTEXT_HEADER: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    INGESTION_QUEUE_MAX: z.coerce.number().int().positive().default(100),
    STARTING_VITALITY_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_STARTING_VITALITY_TOKENS),
    // The MCP server whitelist as a JSON array (companion-tools.md §6); default
    // empty so runtime tool acquisition is off unless an operator lists servers.
    MCP_SERVERS: z.string().default('[]'),
    // Max tools a companion carries equipped at once (companion-tools.md §4); the
    // LRU evicts the least-recently-used tool beyond this.
    MAX_EQUIPPED_TOOLS: z.coerce.number().int().positive().default(8),
    // The CLI tool-definition directory (companion-tools.md §6) — the CLI trust
    // boundary; default empty so the CLI track is off unless an operator sets it.
    CLI_TOOLS_PATH: z.string().default(''),
    // Root for per-tenant ephemeral CLI working dirs; empty → the OS temp dir.
    CLI_SCRATCH_DIR: z.string().default(''),
    APP_URL: z.string().url().default('http://localhost:3001'),
    AUTH_MODE: z.enum(['google', 'dev_bypass', 'service_token']).default('google'),
    // Public OAuth Web client ID — shipped to the browser, not a secret.
    GOOGLE_CLIENT_ID: z.string().default(''),
    DEV_BYPASS_EMAIL: z.string().email().default('dev@cobble.local'),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.string().default('development'),
    TRACING_PROVIDER: z.enum(['none', 'langfuse']).default('none'),
    LANGFUSE_PUBLIC_KEY: z.string().default(''),
    LANGFUSE_SECRET_KEY: z.string().default(''),
    // HTTPS only — the host receives the Basic-auth keys + (redacted) trace
    // payload, so it must not travel in cleartext (security.md). `http://` is
    // permitted solely for a localhost self-hosted Langfuse during dev.
    LANGFUSE_HOST: z
      .string()
      .url()
      .refine(
        (value) =>
          value.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(value),
        'LANGFUSE_HOST must use https (http allowed only for localhost)',
      )
      .default('https://cloud.langfuse.com'),
    TRACING_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    TRACING_REDACT: z.enum(['strict', 'metadata_only', 'off']).default('strict'),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
        path: ['OPENROUTER_API_KEY'],
      });
    }
    if (env.EMBEDDING_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENROUTER_API_KEY is required when EMBEDDING_PROVIDER=openrouter',
        path: ['OPENROUTER_API_KEY'],
      });
    }
    if (env.AUTH_MODE === 'google' && env.GOOGLE_CLIENT_ID.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_CLIENT_ID is required when AUTH_MODE=google',
        path: ['GOOGLE_CLIENT_ID'],
      });
    }
    if (
      env.TRACING_PROVIDER === 'langfuse' &&
      (env.LANGFUSE_PUBLIC_KEY.length === 0 || env.LANGFUSE_SECRET_KEY.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required when TRACING_PROVIDER=langfuse',
        path: ['LANGFUSE_SECRET_KEY'],
      });
    }
    // The read-only CLI tool dir must not overlap the writable CLI scratch dir
    // (its default is the OS temp dir when CLI_SCRATCH_DIR is unset) — else a
    // scratch write could land a binary inside the trust boundary (companion-tools.md §6).
    if (env.CLI_TOOLS_PATH.length > 0) {
      const scratchDir = env.CLI_SCRATCH_DIR.length > 0 ? env.CLI_SCRATCH_DIR : tmpdir();
      if (pathsOverlap(env.CLI_TOOLS_PATH, scratchDir)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'CLI_TOOLS_PATH must not overlap the CLI scratch dir (CLI_SCRATCH_DIR, or the OS ' +
            'temp dir when it is unset) — the tools dir must stay read-only (companion-tools.md §6)',
          path: ['CLI_TOOLS_PATH'],
        });
      }
    }
  });

/** One MCP whitelist entry as it appears in the `MCP_SERVERS` JSON array. */
const mcpServerSchema = z.object({
  ref: z.string().min(1),
  endpoint: z.string().url(),
  label: z.string().optional(),
  /** Name of the env var holding this server's bearer token (resolved at connect time). */
  authTokenEnv: z.string().optional(),
});

/** Parse + validate the `MCP_SERVERS` JSON; throws a clear error on bad input. */
function parseMcpServers(raw: string): readonly McpWhitelistEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('MCP_SERVERS must be a JSON array of { ref, endpoint, label?, authTokenEnv? }');
  }
  // Map through conditional spreads so optional keys are omitted (not set to
  // `undefined`) — required under exactOptionalPropertyTypes.
  return z
    .array(mcpServerSchema)
    .parse(json)
    .map((entry) => ({
      ref: entry.ref,
      endpoint: entry.endpoint,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.authTokenEnv !== undefined ? { authTokenEnv: entry.authTokenEnv } : {}),
    }));
}

/** Load and validate config from the environment; throws on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    llmProvider: parsed.LLM_PROVIDER,
    openrouterApiKey: parsed.OPENROUTER_API_KEY,
    llmModel: parsed.LLM_MODEL,
    embeddingProvider: parsed.EMBEDDING_PROVIDER,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingDimensions: parsed.EMBEDDING_DIM,
    ingestionModel: parsed.INGESTION_MODEL,
    ingestionMaxBytes: parsed.INGESTION_MAX_BYTES,
    useContextHeader: parsed.USE_CONTEXT_HEADER,
    ingestionQueueMax: parsed.INGESTION_QUEUE_MAX,
    startingVitalityTokens: parsed.STARTING_VITALITY_TOKENS,
    mcpServers: parseMcpServers(parsed.MCP_SERVERS),
    maxEquippedTools: parsed.MAX_EQUIPPED_TOOLS,
    cliToolsPath: parsed.CLI_TOOLS_PATH,
    cliScratchDir: parsed.CLI_SCRATCH_DIR,
    appUrl: parsed.APP_URL,
    authMode: parsed.AUTH_MODE,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    devBypassEmail: parsed.DEV_BYPASS_EMAIL,
    port: parsed.PORT,
    isProduction: parsed.NODE_ENV === 'production',
    tracingProvider: parsed.TRACING_PROVIDER,
    langfusePublicKey: parsed.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: parsed.LANGFUSE_SECRET_KEY,
    langfuseHost: parsed.LANGFUSE_HOST,
    tracingSampleRate: parsed.TRACING_SAMPLE_RATE,
    tracingRedact: parsed.TRACING_REDACT,
  };
}

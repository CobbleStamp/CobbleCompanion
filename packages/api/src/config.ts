import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { McpWhitelistEntry, RedactionMode } from '@cobble/core';
import { DEFAULT_STARTING_VITALITY_TOKENS, type ServiceCredentialSeed } from '@cobble/db';
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
 * Authentication is **per-request**, not a server-wide mode — both schemes are
 * always live and a request is routed by the credentials it carries (the composite
 * verifier, jwt-verifier.ts). Google Sign-In (a bearer Google ID token, verified
 * against Google's JWKS) and `service_token` (a trusted backend's `(client_id,
 * secret)` pair validated against the `service_registry`, naming the acting user via
 * `X-User-Id`) coexist on one server: a browser client and a backend consumer hit the
 * same endpoints simultaneously.
 */

/**
 * Where staged upload bytes live (staging-object-storage.md). A discriminated
 * union so the wiring can build the matching store and the type system guarantees
 * the backend's required fields are present (validated in `superRefine`).
 */
export type UploadStagingConfig =
  | {
      readonly backend: 's3';
      readonly prefix: string;
      readonly ttlMs: number;
      readonly bucket: string;
      readonly region: string;
    }
  | {
      readonly backend: 'file';
      readonly prefix: string;
      readonly ttlMs: number;
      readonly root: string;
      /** API origin used to build the local upload-slot URL. */
      readonly publicBaseUrl: string;
    };

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
  /** Where staged upload bytes live between accept and ingest (staging-object-storage.md). */
  readonly uploadStaging: UploadStagingConfig;
  /** A/B knob: prefix the Pass-2 context header onto embedding inputs. */
  readonly useContextHeader: boolean;
  /** Backstop cap on queued+in-flight ingestion runs across all owners. */
  readonly ingestionQueueMax: number;
  /** Job-queue claim lease — a companion drain holds its claim this long. The
   *  heartbeat renews it *during* a drain, so the lease no longer has to exceed the
   *  slowest job; it only bounds how long a wedged/partitioned node keeps its claim
   *  before the work is reclaimed (job-processor.ts). Must exceed jobHeartbeatMs. */
  readonly jobLeaseMs: number;
  /** How often a drain renews its claim while running. The "silence cap": if the
   *  node cannot renew for ~jobLeaseMs (event-loop wedge or DB partition), the lease
   *  lapses and the work is reclaimed. Must be < jobLeaseMs (renew several times per
   *  lease so a single missed beat never expires it). */
  readonly jobHeartbeatMs: number;
  /** Coarse poll interval — the clock for idle/future-dated background work. */
  readonly jobPollIntervalMs: number;
  /** Max concurrent companion drains per node (K) — sized to resource ceilings. */
  readonly jobConcurrency: number;
  /** WS embodiment heartbeat interval — the node renews its claim this often while
   *  the socket is open (deliver-scalability.md §5.2). */
  readonly wsHeartbeatMs: number;
  /** WS embodiment claim TTL — a claim with no heartbeat for this long is dead and
   *  reclaimable (crash backstop). A small multiple of the heartbeat. */
  readonly wsClaimTtlMs: number;
  /** Max bytes for a single inbound WS frame. Frames are JSON control envelopes, so
   *  this is small — it caps the synchronous `JSON.parse` cost and rejects an
   *  oversized frame at the transport before any work (security: bounds event-loop
   *  stall from a giant frame). */
  readonly wsMaxPayloadBytes: number;
  /** Max requests dispatched concurrently on one connection. Frames multiplex, so
   *  one socket can fan out many handlers; this sheds load past the cap (a frame
   *  over it gets a `rate_limited` error, never dispatched) so a single authed
   *  client can't exhaust CPU / the DB pool. */
  readonly wsMaxInFlight: number;
  /** Max bytes the server may have queued (unsent) toward a single connection
   *  before it is treated as a non-draining (slow/stuck/dead) consumer and closed.
   *  A WS write never blocks: bytes a slow client hasn't acked pile up in the
   *  process heap (`socket.bufferedAmount`), so without this ceiling one stuck
   *  connection can OOM the whole node. On close the client reconnects and resumes
   *  live delivery from its cursor (no events lost), so this trades a slow client's
   *  socket for the node's memory safety (deliver-scalability.md §5.2). */
  readonly wsMaxBufferedBytes: number;
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
  /**
   * Server-to-server consumer credentials to provision on launch (implementation.md §5).
   * Parsed from `SERVICE_REGISTRY_SEEDS` (a JSON array of `{ client_id, secret, secret_type?,
   * label? }`). Seeding is additive + idempotent: each pair is inserted once and re-seeding
   * is a no-op. Empty (default) seeds nothing — the CLI remains the path for provisioning.
   */
  readonly serviceRegistrySeeds: readonly ServiceCredentialSeed[];
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
  readonly googleClientId: string;
  /** HS256 secret the API signs its own session access/refresh tokens with
   *  (auth/session-tokens.ts). Never shipped to the browser; deployment-managed. */
  readonly jwtSigningSecret: string;
  /**
   * The `service_registry.client_id` of the Discord adapter (companion-discord.md §9).
   * Gates the internal token-mint endpoint (`POST /internal/discord/token`): only this
   * service client may mint user access tokens for Discord, and the route is disabled
   * (404) when this is empty. Empty (default) leaves the Discord surface off.
   */
  readonly discordServiceClientId: string;
  /**
   * Base64 of the 32-byte AES-256-GCM key the API uses to **encrypt** a Discord bot
   * token before storing it (the `discord.config.*` WS methods, T13), and the worker
   * uses to decrypt it. Empty (default) disables the `discord.config.*` methods — the
   * web settings panel reports Discord as unavailable. Shared key, deployment-managed.
   */
  readonly discordTokenKey: string;
  /** Lifetime (seconds) of an app access token — short, since it rides the WS
   *  handshake URL and is refreshed on demand against /auth/refresh. */
  readonly accessTokenTtlSec: number;
  /** Lifetime (seconds) of the refresh token in the HttpOnly cookie — the hard cap
   *  on a session before the user must re-authenticate with Google. */
  readonly refreshTokenTtlSec: number;
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
    // Upload staging (staging-object-storage.md). `s3` in production (bytes go
    // straight to a bucket via presigned PUT); `file` for local/CI (a root dir is
    // required — validated below). TTL mirrors the S3 bucket lifecycle rule.
    UPLOAD_STAGING_BACKEND: z.enum(['s3', 'file']).default('file'),
    UPLOAD_STAGING_S3_BUCKET: z.string().default(''),
    // Falls back to the ambient AWS_REGION when unset (handled in loadConfig).
    UPLOAD_STAGING_S3_REGION: z.string().default(''),
    // Slash-separated alphanumeric/_/- segments only: no dots (so no `..`), no
    // leading/trailing slash, never absolute — a forged prefix can't point the fs
    // `purgeExpired` sweep (resolve(root, prefix)) outside the staging root.
    UPLOAD_STAGING_PREFIX: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/,
        'UPLOAD_STAGING_PREFIX must be slash-separated alphanumeric/_/- segments (no "..", no leading/trailing slash)',
      )
      .default('tmp-uploads'),
    UPLOAD_STAGING_FS_ROOT: z.string().default(''),
    // API origin the local upload-slot URL points at; empty → derived from PORT.
    UPLOAD_STAGING_PUBLIC_BASE_URL: z.string().default(''),
    UPLOAD_STAGING_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      // Cap at 1 day so the minted presigned PUT capability can't outlive the S3
      // bucket's 1-day expiry lifecycle rule.
      .max(24 * 60 * 60 * 1000)
      .default(60 * 60 * 1000),
    USE_CONTEXT_HEADER: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    INGESTION_QUEUE_MAX: z.coerce.number().int().positive().default(100),
    // Job-queue tuning (deliver-scalability.md §5.1.6). The lease is renewed
    // *during* a drain by the heartbeat, so it no longer has to exceed the slowest
    // job — it only bounds how long a wedged/partitioned node keeps its claim.
    JOB_LEASE_MS: z.coerce.number().int().positive().default(60_000),
    JOB_HEARTBEAT_MS: z.coerce.number().int().positive().default(20_000),
    JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    JOB_CONCURRENCY: z.coerce.number().int().positive().default(4),
    WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
    WS_CLAIM_TTL_MS: z.coerce.number().int().positive().default(30_000),
    // A WS frame is a JSON control envelope; 256 KiB is generous for any message
    // (e.g. pasted chat content) while bounding the per-frame JSON.parse cost.
    WS_MAX_PAYLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(256 * 1024),
    // Per-connection in-flight dispatch cap (load-shedding backstop).
    WS_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(32),
    // Per-connection outbound backpressure ceiling: past this many unsent bytes
    // queued toward one client, the connection is closed (slow/dead consumer) so a
    // non-draining socket can't grow the heap without bound. 8 MiB is generous for
    // a healthy client's transient catch-up burst while bounding worst-case memory.
    WS_MAX_BUFFERED_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),
    STARTING_VITALITY_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_STARTING_VITALITY_TOKENS),
    // The MCP server whitelist as a JSON array (companion-tools.md §6); default
    // empty so runtime tool acquisition is off unless an operator lists servers.
    MCP_SERVERS: z.string().default('[]'),
    // Server-to-server consumer credentials to provision on launch (implementation.md §5),
    // as a JSON array of { client_id, secret, secret_type?, label? }. Default empty seeds
    // nothing. Secrets are never committed — supply via the deployment environment.
    SERVICE_REGISTRY_SEEDS: z.string().default('[]'),
    // Max tools a companion carries equipped at once (companion-tools.md §4); the
    // LRU evicts the least-recently-used tool beyond this.
    MAX_EQUIPPED_TOOLS: z.coerce.number().int().positive().default(8),
    // The CLI tool-definition directory (companion-tools.md §6) — the CLI trust
    // boundary; default empty so the CLI track is off unless an operator sets it.
    CLI_TOOLS_PATH: z.string().default(''),
    // Root for per-tenant ephemeral CLI working dirs; empty → the OS temp dir.
    CLI_SCRATCH_DIR: z.string().default(''),
    APP_URL: z.string().url().default('http://localhost:3001'),
    // Public OAuth Web client ID — shipped to the browser, not a secret. Required:
    // Google Sign-In is the browser scheme (validated below).
    GOOGLE_CLIENT_ID: z.string().default(''),
    // HS256 secret for the API's own session tokens (auth/session-tokens.ts).
    // Required (validated below); >=32 bytes so the HMAC key has adequate entropy.
    // Never committed — supply via the deployment environment.
    JWT_SIGNING_SECRET: z.string().default(''),
    // The Discord adapter's service-registry client id (companion-discord.md §9).
    // Empty (default) disables the internal token-mint endpoint — the Discord surface
    // stays off until an operator both registers the service client and sets this.
    DISCORD_SERVICE_CLIENT_ID: z.string().default(''),
    // Base64 of the 32-byte AES key for Discord bot-token encryption (T13). Empty
    // (default) disables the discord.config.* WS methods.
    DISCORD_TOKEN_KEY: z.string().default(''),
    // App access-token lifetime (seconds); default 15 min. Short — it's refreshed
    // on demand and travels the WS handshake URL.
    ACCESS_TOKEN_TTL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    // Refresh-token (HttpOnly cookie) lifetime (seconds); default 24h — the hard cap
    // before a Google re-authentication is required.
    REFRESH_TOKEN_TTL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60),
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
    // Google Sign-In is the browser scheme, so the OAuth client id is always required.
    if (env.GOOGLE_CLIENT_ID.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_CLIENT_ID is required',
        path: ['GOOGLE_CLIENT_ID'],
      });
    }
    // The API signs its own session tokens, so the HMAC secret is always required.
    if (env.JWT_SIGNING_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'JWT_SIGNING_SECRET is required and must be at least 32 bytes (never hardcoded; ' +
          'supply via the deployment environment)',
        path: ['JWT_SIGNING_SECRET'],
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
    // Upload staging: each backend has its own required field (fail fast — a
    // misconfigured staging store loses uploads silently otherwise).
    if (env.UPLOAD_STAGING_BACKEND === 's3' && env.UPLOAD_STAGING_S3_BUCKET.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'UPLOAD_STAGING_S3_BUCKET is required when UPLOAD_STAGING_BACKEND=s3',
        path: ['UPLOAD_STAGING_S3_BUCKET'],
      });
    }
    if (
      env.UPLOAD_STAGING_BACKEND === 's3' &&
      env.UPLOAD_STAGING_S3_REGION.length === 0 &&
      (process.env.AWS_REGION ?? '').length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'UPLOAD_STAGING_S3_REGION (or the ambient AWS_REGION) is required when ' +
          'UPLOAD_STAGING_BACKEND=s3',
        path: ['UPLOAD_STAGING_S3_REGION'],
      });
    }
    if (env.UPLOAD_STAGING_BACKEND === 'file' && env.UPLOAD_STAGING_FS_ROOT.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'UPLOAD_STAGING_FS_ROOT is required when UPLOAD_STAGING_BACKEND=file',
        path: ['UPLOAD_STAGING_FS_ROOT'],
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
    // The drain renews its claim every JOB_HEARTBEAT_MS; the lease must outlast a
    // few beats or a single slow/missed renewal would expire it and hand a live
    // companion to another node (job-processor.ts).
    if (env.JOB_HEARTBEAT_MS >= env.JOB_LEASE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'JOB_HEARTBEAT_MS must be less than JOB_LEASE_MS',
        path: ['JOB_HEARTBEAT_MS'],
      });
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

/**
 * One service-registry seed as it appears in the `SERVICE_REGISTRY_SEEDS` JSON array.
 * `client_id`/`secret_type` use the registry's snake_case vocabulary (matching the
 * `X-Service-Client-Id` header and the `service_registry` column); they normalize to the
 * camelCase `ServiceCredentialSeed` shape below.
 */
const serviceSeedSchema = z.object({
  client_id: z.string().min(1),
  secret: z.string().min(1),
  secret_type: z.string().min(1).optional(),
  label: z.string().optional(),
});

/** Parse + validate the `SERVICE_REGISTRY_SEEDS` JSON; throws a clear error on bad input. */
function parseServiceRegistrySeeds(raw: string): readonly ServiceCredentialSeed[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      'SERVICE_REGISTRY_SEEDS must be a JSON array of { client_id, secret, secret_type?, label? }',
    );
  }
  // Conditional spreads omit optional keys (not set to `undefined`) — required under
  // exactOptionalPropertyTypes.
  return z
    .array(serviceSeedSchema)
    .parse(json)
    .map((seed) => ({
      clientId: seed.client_id,
      secret: seed.secret,
      ...(seed.secret_type !== undefined ? { secretType: seed.secret_type } : {}),
      ...(seed.label !== undefined ? { label: seed.label } : {}),
    }));
}

/**
 * Resolve the upload-staging backend config from validated env. The discriminant
 * has been checked in `superRefine`, so the required field for each backend is
 * present here. The fs `publicBaseUrl` falls back to a local API origin; the s3
 * region falls back to the ambient `AWS_REGION`.
 */
function buildUploadStagingConfig(parsed: z.infer<typeof envSchema>): UploadStagingConfig {
  const prefix = parsed.UPLOAD_STAGING_PREFIX;
  const ttlMs = parsed.UPLOAD_STAGING_TTL_MS;
  if (parsed.UPLOAD_STAGING_BACKEND === 's3') {
    return {
      backend: 's3',
      prefix,
      ttlMs,
      bucket: parsed.UPLOAD_STAGING_S3_BUCKET,
      region: parsed.UPLOAD_STAGING_S3_REGION || (process.env.AWS_REGION ?? ''),
    };
  }
  const publicBaseUrl = parsed.UPLOAD_STAGING_PUBLIC_BASE_URL || `http://localhost:${parsed.PORT}`;
  return { backend: 'file', prefix, ttlMs, root: parsed.UPLOAD_STAGING_FS_ROOT, publicBaseUrl };
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
    uploadStaging: buildUploadStagingConfig(parsed),
    useContextHeader: parsed.USE_CONTEXT_HEADER,
    ingestionQueueMax: parsed.INGESTION_QUEUE_MAX,
    jobLeaseMs: parsed.JOB_LEASE_MS,
    jobHeartbeatMs: parsed.JOB_HEARTBEAT_MS,
    jobPollIntervalMs: parsed.JOB_POLL_INTERVAL_MS,
    jobConcurrency: parsed.JOB_CONCURRENCY,
    wsHeartbeatMs: parsed.WS_HEARTBEAT_MS,
    wsClaimTtlMs: parsed.WS_CLAIM_TTL_MS,
    wsMaxPayloadBytes: parsed.WS_MAX_PAYLOAD_BYTES,
    wsMaxInFlight: parsed.WS_MAX_IN_FLIGHT,
    wsMaxBufferedBytes: parsed.WS_MAX_BUFFERED_BYTES,
    startingVitalityTokens: parsed.STARTING_VITALITY_TOKENS,
    mcpServers: parseMcpServers(parsed.MCP_SERVERS),
    serviceRegistrySeeds: parseServiceRegistrySeeds(parsed.SERVICE_REGISTRY_SEEDS),
    maxEquippedTools: parsed.MAX_EQUIPPED_TOOLS,
    cliToolsPath: parsed.CLI_TOOLS_PATH,
    cliScratchDir: parsed.CLI_SCRATCH_DIR,
    appUrl: parsed.APP_URL,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    jwtSigningSecret: parsed.JWT_SIGNING_SECRET,
    discordServiceClientId: parsed.DISCORD_SERVICE_CLIENT_ID,
    discordTokenKey: parsed.DISCORD_TOKEN_KEY,
    accessTokenTtlSec: parsed.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: parsed.REFRESH_TOKEN_TTL_SEC,
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

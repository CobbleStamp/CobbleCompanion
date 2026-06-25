import { CompanionNotFoundError } from '@cobble/core';
import type {
  CompanionAffectStore,
  CompanionEventBus,
  CompanionEventLog,
  CompanionWorkRequester,
  EmbeddingGateway,
  EmbodimentStore,
  EpisodicMemoryStore,
  FoodStore,
  GreetingService,
  GrowthService,
  GrowthStore,
  Harness,
  IdentityStore,
  IngestWorkRequester,
  LeadStore,
  Logger,
  MemoryStore,
  PresenceStore,
  ProactiveOutcomeStore,
  ProceduralStore,
  ProposalStore,
  QueueMetricsReader,
  ReactionStore,
  ReactionWorkRequester,
  SemanticMemoryStore,
  UploadStagingStore,
  ToolCallLog,
  ToolRegistry,
  UserModelStore,
  VitalityStore,
} from '@cobble/core';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { makeRequireAdmin, makeRequireAuth } from './auth-guard.js';
import type { TokenVerifier } from './auth/jwt-verifier.js';
import type { AppConfig } from './config.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerSourceRoutes } from './routes/source.routes.js';
import { registerUuidParamGuard } from './uuid.js';
import { registerWebSocket } from './ws/register.js';
import { buildWsMethods } from './ws/methods.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    /** The companion a WS connection embodies, resolved + ownership-checked at the
     *  handshake (Phase D D2). Absent on HTTP requests and transport-only sockets. */
    companionId?: string;
  }
}

/** Everything the API needs, injected so tests can supply fakes/in-memory deps. */
export interface AppDeps {
  readonly identity: IdentityStore;
  /** The User Model — per-user identity facts (Phase 11). Seeds the name on sign-in
   *  and backs the user-model routes; the harness reads/writes it during a turn. */
  readonly userModel: UserModelStore;
  readonly memory: MemoryStore;
  /** The standing companion event channel's bus (architecture.md §6) — fed by the
   *  publish-on-append MemoryStore decorator, drained by the event-channel route. */
  readonly eventBus: CompanionEventBus;
  /** Durable cross-node event log (Phase D D4) — the live embodiment connection's
   *  heartbeat reads it by cursor and pushes events over the WS. */
  readonly eventLog: CompanionEventLog;
  readonly semantic: SemanticMemoryStore;
  readonly episodic: EpisodicMemoryStore;
  readonly embeddings: EmbeddingGateway;
  /** Durable byte staging for the two-part upload (deliver-scalability.md §6 D-A). */
  readonly staging: UploadStagingStore;
  /** Enqueues `ingest` jobs (with fleet-wide backpressure) — the durable successor
   *  to the in-process IngestionRunner. */
  readonly ingest: IngestWorkRequester;
  /** The live embodiment claim (Phase D D2): one WS connection holds a companion at
   *  a time; the handshake claims it, the heartbeat renews it. */
  readonly embodiment: EmbodimentStore;
  /** Off-request episodic reflection — the message route requests it post-turn. */
  readonly consolidation: CompanionWorkRequester;
  readonly harness: Harness;
  /** The tools available to the companion (P3) — also used to run approved calls. */
  readonly tools: ToolRegistry;
  /** The propose→approve queue (P3). */
  readonly proposals: ProposalStore;
  /** The "every tool call is logged" audit log (P3). */
  readonly toolCallLog: ToolCallLog;
  /** Read-only queue/embodiment observability snapshot — the admin `/admin/queue`
   *  surface (deliver-scalability.md §C "C2"). */
  readonly queueMetrics: QueueMetricsReader;
  /** The lead inventory — the companion's reading list (P3 substrate). */
  readonly leads: LeadStore;
  /** Procedural memory — learned, reusable workflows (P3 seed). */
  readonly procedural: ProceduralStore;
  /** Volatile presence signal per companion — the motivation engine's environment (P4). */
  readonly presence: PresenceStore;
  /** Off-request proactive ticks — routes request it on activity/return (P4). */
  readonly motivation: CompanionWorkRequester;
  /** The arrival greeting — the bond-driven reaction to the user returning (P14). */
  readonly greeting: GreetingService;
  /** Per-companion STAMINA wallet — the user-initiated budget (chat/search/tasks). */
  readonly quota: VitalityStore;
  /** Per-companion ENERGY wallet — the self-initiated budget, surfaced as the meter (P4). */
  readonly energy: VitalityStore;
  /** Per-user FOOD pantry — the feeding economy's supply (P5). */
  readonly food: FoodStore;
  /** Reinforcement log — one outcome per proactive initiation (P4). */
  readonly rewards: ProactiveOutcomeStore;
  /** Emoji reactions on transcript messages, both directions (companion-reactions.md). */
  readonly reactions: ReactionStore;
  /** The will's half of the reaction loop — enqueues a `reaction_learn` job so the
   *  read + drive-weight learning runs off-request under the companion claim
   *  (companion-reactions.md §4; deliver-scalability.md §5.1). */
  readonly reactionLearn: ReactionWorkRequester;
  /** The rolling read of the user's mood, sensed in the agent loop (P4.2). */
  readonly affect: CompanionAffectStore;
  /**
   * Four-axis growth derived from substrate; builds the growth standing + notes
   * (P5). The message route recomputes it inline as the tail of each turn's stream,
   * so a crossed-band reflection is felt in place.
   */
  readonly growth: GrowthService;
  /** The growth high-water mark — used to fire reflections once (P5). */
  readonly growthStore: GrowthStore;
  /** Authenticates every request that carries a credential: the composite routes a
   *  service caller (by its header) to the service verifier, else verifies the API's
   *  own session **access** token (auth/session-tokens.ts). */
  readonly tokenVerifier: TokenVerifier;
  /** Verifies a Google ID token — used **only** by `POST /auth/session` to bootstrap
   *  a session (the browser's normal requests carry an app access token, not a Google
   *  token, so the Google verifier is no longer on the per-request path). */
  readonly googleVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly logger: Logger;
}

// API route prefixes that must 404 (not fall through to the SPA index.html).
const API_PREFIXES = ['/admin', '/auth', '/companions', '/food', '/health'] as const;

// Query-string params that carry a live bearer credential and must never reach the
// access log. A browser `WebSocket` cannot set an Authorization header, so the bearer
// rides the WS handshake URL as `?access_token=<jwt>` (see ws/handshake.ts). Fastify's
// default `req` serializer logs the full URL — query string included — so without this
// redaction a replayable token would land in stdout/access logs.
const SENSITIVE_QUERY_PARAMS = ['access_token', 'token'] as const;

/** Redact credential-bearing query params from a request URL before it is logged. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  const path = url.slice(0, queryStart);
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let redacted = false;
  for (const name of SENSITIVE_QUERY_PARAMS) {
    if (params.has(name)) {
      params.set(name, 'REDACTED');
      redacted = true;
    }
  }
  return redacted ? `${path}?${params.toString()}` : url;
}

/** Build the Fastify app — the only surface↔core boundary (invariant #1). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Request access logging — every request/response (method, url, status,
    // remoteAddress, responseTime). Fastify's default serializers do NOT log
    // headers, so the Authorization bearer never lands in the access log — but the
    // default DOES log the full URL, query string included, and a browser WS client
    // sends its bearer as `?access_token=<jwt>` (ws/handshake.ts). Override the `req`
    // serializer to redact credential-bearing query params so the token never lands
    // in the log. Application/business logging still flows through deps.logger.
    logger: {
      serializers: {
        req(request: FastifyRequest) {
          const remotePort = request.socket?.remotePort;
          return {
            method: request.method,
            url: redactUrl(request.url),
            host: request.host,
            remoteAddress: request.ip,
            ...(remotePort === undefined ? {} : { remotePort }),
          };
        },
      },
    },
    // Behind a reverse proxy (Caddy) terminating TLS on the same host: honour the
    // X-Forwarded-* headers so request.ip / request.protocol reflect the real
    // client, not the proxy. Safe because the Node listener binds localhost and is
    // only reachable through the proxy — no untrusted client can spoof the headers.
    trustProxy: true,
  });

  // The refresh token rides an HttpOnly cookie (auth.routes.ts), so the browser must
  // send credentials cross-origin in dev (Vite on :3001 → API on :3000). `credentials:
  // true` requires a non-wildcard origin — which we already pin to appUrl.
  await app.register(cors, {
    origin: deps.config.appUrl,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  await app.register(cookie);

  // Tolerate an empty body on application/json requests. Fastify's default JSON
  // parser rejects an empty body with 400 FST_ERR_CTP_EMPTY_JSON_BODY — and that
  // happens before preHandlers, so a client that sends `content-type:
  // application/json` on a bodyless POST is rejected before auth even runs. Treat
  // an empty body as "no body"; routes that require a payload validate it
  // themselves and return a clear 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string).trim();
    if (text.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Central error logging (common/logging.md: never swallow an error). This routes
  // failures through the structured app logger (deps.logger) with full business
  // context — distinct from Fastify's request access log. Log unexpected (5xx)
  // errors at `error` severity with full context — including the error itself
  // (message + stack) — and return a generic message so internals never leak.
  // Client errors (4xx: validation, bad content-type) are logged at `info` for
  // visibility and pass their message through.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A debit/feed against a missing (or deleted) companion is a 404, wherever it
    // surfaces — map it centrally so every route is uniform (the core error stays
    // HTTP-agnostic; the status lives here).
    const statusCode = error instanceof CompanionNotFoundError ? 404 : (error.statusCode ?? 500);
    const context: Record<string, unknown> = {
      operation: 'http.request',
      method: request.method,
      // redactUrl, not request.url: a WS handshake error reaches here too, and the
      // browser WS bearer rides the URL as `?access_token=<jwt>` (ws/handshake.ts).
      url: redactUrl(request.url),
      statusCode,
      code: error.code,
      userId: request.userId,
    };
    if (statusCode >= 500) {
      deps.logger.error('request failed', { ...context, error });
      return reply.code(statusCode).send({ error: 'internal server error' });
    }
    deps.logger.info('request rejected', { ...context, message: error.message });
    return reply.code(statusCode).send({ error: error.message });
  });

  // Reject malformed resource-id path params with a clean 404 before they reach
  // a DB query (else a bad UUID 500s with Postgres 22P02). Global, so every route
  // — current and future — is uniform without per-handler boilerplate (uuid.ts).
  registerUuidParamGuard(app);

  app.get('/health', async () => ({ status: 'ok' }));

  const requireAuth = makeRequireAuth(deps);
  const requireAdmin = makeRequireAdmin(deps);

  // The product surface is the realtime WS (below). Only a few HTTP routes remain:
  // the public auth bootstrap (fetched before the client can authenticate), the
  // filesystem upload sink (mounted only for the local `file` staging backend — the
  // local equivalent of a presigned S3 PUT; staging-object-storage.md), and the
  // admin-only observability read (ops tooling speaks HTTP, not the WS envelope).
  // Everything else is a WS method (deliver-scalability.md §6).
  registerAuthRoutes(app, deps);
  registerSourceRoutes(app, deps, requireAuth);
  registerAdminRoutes(app, deps, requireAuth, requireAdmin);

  // Realtime WS transport (Phase D): authenticated at the handshake, request/
  // response correlated by id, with server-push events — the one product surface.
  await registerWebSocket(app, deps, buildWsMethods(deps));

  registerSpa(app);

  return app;
}

/**
 * Serve the built React SPA from the same origin as the API (one process serves
 * both). Skipped when the bundle isn't present (local dev runs Vite separately).
 * Non-API GETs fall through to index.html for client-side routing.
 */
function registerSpa(app: FastifyInstance): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built image layout: <root>/api/dist/app.js + <root>/web/dist. From the API
  // dist dir that's ../../web/dist; the dev source layout resolves the same way
  // relative to packages/api/src.
  const webDist = join(here, '..', '..', 'web', 'dist');
  if (!existsSync(join(webDist, 'index.html'))) {
    app.log.warn?.('web bundle not found; SPA serving disabled');
    return;
  }

  void app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    wildcard: false,
    setHeaders: (res, path) => {
      // index.html must always revalidate so a new bundle is picked up; hashed
      // assets are immutable and safe to cache aggressively.
      if (path.endsWith('index.html')) {
        res.setHeader('cache-control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const isApi = API_PREFIXES.some((p) => request.url.startsWith(p));
    if (request.method !== 'GET' || isApi) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

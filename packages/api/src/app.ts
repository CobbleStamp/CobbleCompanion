import { CompanionNotFoundError } from '@cobble/core';
import type {
  CompanionAffectStore,
  ConsolidationRunner,
  EmbeddingGateway,
  EpisodicMemoryStore,
  FoodStore,
  GrowthService,
  GrowthStore,
  Harness,
  IdentityStore,
  IngestionRunner,
  LeadStore,
  Logger,
  MemoryStore,
  MotivationRunner,
  PresenceStore,
  ProactiveOutcomeStore,
  ProceduralStore,
  ProposalStore,
  SemanticMemoryStore,
  ToolCallLog,
  ToolRegistry,
  UserModelStore,
  VitalityStore,
} from '@cobble/core';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { makeRequireAuth } from './auth-guard.js';
import type { TokenVerifier } from './auth/jwt-verifier.js';
import type { AppConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCompanionRoutes } from './routes/companion.routes.js';
import { registerEpisodeRoutes } from './routes/episode.routes.js';
import { registerGrowthRoutes } from './routes/growth.routes.js';
import { registerMemoryRoutes } from './routes/memory.routes.js';
import { registerUserModelRoutes } from './routes/user-model.routes.js';
import { registerMessageRoutes } from './routes/message.routes.js';
import { registerInventoryRoutes } from './routes/inventory.routes.js';
import { registerPresenceRoutes } from './routes/presence.routes.js';
import { registerProactivityRoutes } from './routes/proactivity.routes.js';
import { registerProposalRoutes } from './routes/proposal.routes.js';
import { registerSourceRoutes } from './routes/source.routes.js';
import { registerUsageRoutes } from './routes/usage.routes.js';
import { registerUuidParamGuard } from './uuid.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/** Everything the API needs, injected so tests can supply fakes/in-memory deps. */
export interface AppDeps {
  readonly identity: IdentityStore;
  /** The User Model — per-user identity facts (Phase 11). Seeds the name on sign-in
   *  and backs the user-model routes; the harness reads/writes it during a turn. */
  readonly userModel: UserModelStore;
  readonly memory: MemoryStore;
  readonly semantic: SemanticMemoryStore;
  readonly episodic: EpisodicMemoryStore;
  readonly embeddings: EmbeddingGateway;
  readonly ingestion: IngestionRunner;
  /** Off-request episodic reflection — the message route requests it post-turn. */
  readonly consolidation: ConsolidationRunner;
  readonly harness: Harness;
  /** The tools available to the companion (P3) — also used to run approved calls. */
  readonly tools: ToolRegistry;
  /** The propose→approve queue (P3). */
  readonly proposals: ProposalStore;
  /** The "every tool call is logged" audit log (P3). */
  readonly toolCallLog: ToolCallLog;
  /** The lead inventory — the companion's reading list (P3 substrate). */
  readonly leads: LeadStore;
  /** Procedural memory — learned, reusable workflows (P3 seed). */
  readonly procedural: ProceduralStore;
  /** Volatile presence signal per companion — the motivation engine's environment (P4). */
  readonly presence: PresenceStore;
  /** Off-request proactive ticks — routes request it on activity/return (P4). */
  readonly motivation: MotivationRunner;
  /** Per-companion STAMINA wallet — the user-initiated budget (chat/search/tasks). */
  readonly quota: VitalityStore;
  /** Per-companion ENERGY wallet — the self-initiated budget, surfaced as the meter (P4). */
  readonly energy: VitalityStore;
  /** Per-user FOOD pantry — the feeding economy's supply (P5). */
  readonly food: FoodStore;
  /** Reinforcement log — one outcome per proactive initiation (P4). */
  readonly rewards: ProactiveOutcomeStore;
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
  readonly tokenVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly logger: Logger;
}

// API route prefixes that must 404 (not fall through to the SPA index.html).
const API_PREFIXES = ['/auth', '/companions', '/food', '/health'] as const;

/** Build the Fastify app — the only surface↔core boundary (invariant #1). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Bearer-token auth (Google ID token): no cookies, so CORS credentials are
  // unneeded.
  // Origin still matters for local dev where Vite calls the API cross-origin.
  await app.register(cors, {
    origin: deps.config.appUrl,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Multipart uploads (PDF sources), capped at the configured size.
  await app.register(multipart, {
    limits: { fileSize: deps.config.ingestionMaxBytes, files: 1 },
  });

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

  // Central error logging (common/logging.md: never swallow an error). Fastify's
  // own logger is off, so without this 5xx failures would vanish silently. Log
  // unexpected (5xx) errors at `error` severity with full context — including the
  // error itself (message + stack) — and return a generic message so internals
  // never leak. Client errors (4xx: validation, bad content-type) are logged at
  // `info` for visibility and pass their message through.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A debit/feed against a missing (or deleted) companion is a 404, wherever it
    // surfaces — map it centrally so every route is uniform (the core error stays
    // HTTP-agnostic; the status lives here).
    const statusCode = error instanceof CompanionNotFoundError ? 404 : (error.statusCode ?? 500);
    const context: Record<string, unknown> = {
      operation: 'http.request',
      method: request.method,
      url: request.url,
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

  // The per-companion vitality wallet (architecture.md §4.8) is the cost
  // guardrail; routes enforce it inline (chat/search pre-flight, ingestion
  // defer), so there are no per-route request-count limiters.
  registerAuthRoutes(app, deps, requireAuth);
  registerCompanionRoutes(app, deps, requireAuth);
  registerMessageRoutes(app, deps, requireAuth);
  registerMemoryRoutes(app, deps, requireAuth);
  registerUserModelRoutes(app, deps, requireAuth);
  registerEpisodeRoutes(app, deps, requireAuth);
  registerSourceRoutes(app, deps, requireAuth);
  registerProposalRoutes(app, deps, requireAuth);
  registerInventoryRoutes(app, deps, requireAuth);
  registerPresenceRoutes(app, deps, requireAuth);
  registerProactivityRoutes(app, deps, requireAuth);
  registerGrowthRoutes(app, deps, requireAuth);
  registerUsageRoutes(app, deps, requireAuth);

  registerSpa(app);

  return app;
}

/**
 * Serve the built React SPA from the same origin as the API (single Cloud Run
 * service). Skipped when the bundle isn't present (local dev runs Vite
 * separately). Non-API GETs fall through to index.html for client-side routing.
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

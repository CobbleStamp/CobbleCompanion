import type {
  EmbeddingGateway,
  Harness,
  IdentityStore,
  IngestionRunner,
  Logger,
  MemoryStore,
  SemanticMemoryStore,
} from '@cobble/core';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit, { type errorResponseBuilderContext } from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type preHandlerHookHandler,
} from 'fastify';
import { makeRequireAuth } from './auth-guard.js';
import type { TokenVerifier } from './auth/jwt-verifier.js';
import type { AppConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCompanionRoutes } from './routes/companion.routes.js';
import { registerMemoryRoutes } from './routes/memory.routes.js';
import { registerMessageRoutes } from './routes/message.routes.js';
import { registerSourceRoutes } from './routes/source.routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/** A per-route rate-limit preHandler (built from `app.rateLimit(...)`). */
export type RateLimitHook = preHandlerHookHandler;

/** Everything the API needs, injected so tests can supply fakes/in-memory deps. */
export interface AppDeps {
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  readonly semantic: SemanticMemoryStore;
  readonly embeddings: EmbeddingGateway;
  readonly ingestion: IngestionRunner;
  readonly harness: Harness;
  readonly tokenVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly logger: Logger;
}

// API route prefixes that must 404 (not fall through to the SPA index.html).
const API_PREFIXES = ['/auth', '/companions', '/health'] as const;

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

  // Per-owner rate limiting on the LLM/embedding-spend routes (security.md:
  // rate limiting on expensive endpoints). Registered opt-in (`global: false`)
  // and applied per route as a preHandler *after* auth, so the key is the
  // authenticated owner rather than a shared NAT IP. In-memory store: per
  // instance, which suits the single warm Cloud Run instance (architecture.md
  // §8); a shared store is the multi-replica follow-up.
  await app.register(rateLimit, { global: false });

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
    const statusCode = error.statusCode ?? 500;
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

  app.get('/health', async () => ({ status: 'ok' }));

  const requireAuth = makeRequireAuth(deps);

  // Owner-keyed limiters. The limiter runs *after* requireAuth in the
  // preHandler array, so userId is always set; failing loudly (a logged 500)
  // beats silently falling back to `request.ip`, which behind the Cloud Run LB
  // (no trustProxy) would lump every owner into one shared bucket.
  // In hook mode the plugin THROWS the built value into the central error
  // handler, so it must be a real Error carrying statusCode 429 — a plain
  // object would surface as a 500.
  const ownerKey = (request: FastifyRequest): string => {
    if (request.userId === undefined) {
      throw new Error('rate limiter ran before auth — preHandler ordering bug');
    }
    return request.userId;
  };
  const rateLimitError = (
    _request: FastifyRequest,
    context: errorResponseBuilderContext,
  ): Error & { statusCode: number } =>
    Object.assign(
      new Error(`too many requests — please slow down and try again in ${context.after}`),
      { statusCode: 429 },
    );
  const ingestionLimit = app.rateLimit({
    max: deps.config.ingestionRateMax,
    timeWindow: deps.config.rateLimitWindowMs,
    keyGenerator: ownerKey,
    errorResponseBuilder: rateLimitError,
  });
  const searchLimit = app.rateLimit({
    max: deps.config.searchRateMax,
    timeWindow: deps.config.rateLimitWindowMs,
    keyGenerator: ownerKey,
    errorResponseBuilder: rateLimitError,
  });

  registerAuthRoutes(app, deps, requireAuth);
  registerCompanionRoutes(app, deps, requireAuth);
  registerMessageRoutes(app, deps, requireAuth);
  registerMemoryRoutes(app, deps, requireAuth, { search: searchLimit });
  registerSourceRoutes(app, deps, requireAuth, { ingestion: ingestionLimit });

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

import type { Harness, IdentityStore, Logger, MemoryStore } from '@cobble/core';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeRequireAuth } from './auth-guard.js';
import type { TokenVerifier } from './auth/jwt-verifier.js';
import type { AppConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCompanionRoutes } from './routes/companion.routes.js';
import { registerConversationRoutes } from './routes/conversation.routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/** Everything the API needs, injected so tests can supply fakes/in-memory deps. */
export interface AppDeps {
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
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

  // Bearer-token auth (Auth0): no cookies, so CORS credentials are unneeded.
  // Origin still matters for local dev where Vite calls the API cross-origin.
  await app.register(cors, {
    origin: deps.config.appUrl,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const requireAuth = makeRequireAuth(deps);
  registerAuthRoutes(app, deps, requireAuth);
  registerCompanionRoutes(app, deps, requireAuth);
  registerConversationRoutes(app, deps, requireAuth);

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

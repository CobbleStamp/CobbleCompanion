import type { AuthTokenStore, Harness, IdentityStore, Logger, MemoryStore } from '@cobble/core';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { EmailSender } from './email.js';
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
  readonly authTokens: AuthTokenStore;
  readonly memory: MemoryStore;
  readonly harness: Harness;
  readonly email: EmailSender;
  readonly config: AppConfig;
  readonly logger: Logger;
}

/** Build the Fastify app — the only surface↔core boundary (invariant #1). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(cors, {
    origin: deps.config.appUrl,
    credentials: true,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, deps);
  registerCompanionRoutes(app, deps);
  registerConversationRoutes(app, deps);

  return app;
}

import { createCompanionSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth-guard.js';

export function registerCompanionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { identity } = deps;

  app.post('/companions', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createCompanionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid companion details' });
    }
    const companion = await identity.createCompanion(request.userId!, parsed.data);
    return reply.code(201).send({ companion });
  });

  app.get('/companions', { preHandler: requireAuth }, async (request, reply) => {
    const companions = await identity.listCompanions(request.userId!);
    return reply.send({ companions });
  });
}

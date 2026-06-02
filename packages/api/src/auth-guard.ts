import type { FastifyReply, FastifyRequest } from 'fastify';
import { readSession } from './session.js';

/**
 * preHandler that enforces authentication and sets `request.userId` for tenancy
 * scoping (architecture.md §8: authorization at the API boundary before the core).
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = readSession(request);
  if (!userId) {
    await reply.code(401).send({ error: 'authentication required' });
    return;
  }
  request.userId = userId;
}

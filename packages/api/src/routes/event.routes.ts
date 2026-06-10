import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { streamChannel } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}

/**
 * The standing companion event channel (architecture.md §6). A surface opens this
 * once and keeps it open: every row appended to the companion's transcript — a
 * turn reply, an ingestion note, a greeting, a proactive nudge — is pushed here
 * the moment it persists, regardless of which request produced it.
 *
 * GET (not POST): it has no side effects — it only subscribes and reads. Ownership
 * is checked before subscribing (invariant #5); the subscription is released when
 * the client disconnects (`streamChannel`). Delivery only — durability lives in
 * the transcript, and a client recovers anything missed while disconnected from
 * its reconnect snapshot, so the channel carries no replay buffer.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, eventBus, logger } = deps;

  app.get(
    '/companions/:companionId/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const subscription = eventBus.subscribe(companion.id);
      await streamChannel(reply, request, subscription, logger);
    },
  );
}

/**
 * Presence heartbeat (Phase 4, companion-motivation.md §4). The web client pings
 * this while the tab is open so the motivation engine knows whether the user is
 * here, and whether the tab is in front — the dominant signal shaping proactive
 * behaviour. Presence is volatile (in-memory), so this only records; there is no
 * read endpoint. Owner-scoped like every companion route.
 */

import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerPresenceRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, presence } = deps;

  app.post(
    '/companions/:companionId/heartbeat',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      // Default to visible: a heartbeat means the client is alive; the absence of
      // an explicit flag shouldn't read as "hidden".
      const body = request.body as { tabVisible?: unknown } | undefined;
      const tabVisible = typeof body?.tabVisible === 'boolean' ? body.tabVisible : true;
      presence.recordHeartbeat(companion.id, { tabVisible });
      return reply.code(204).send();
    },
  );
}

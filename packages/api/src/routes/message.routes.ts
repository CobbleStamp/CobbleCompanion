import { sendMessageSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { overCapGuard } from '../quota-guard.js';
import { streamSse } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}

/**
 * The companion's single continuous conversation (architecture.md invariant: one
 * lifelong conversation per companion, no conversation/session entity). Messages
 * attach directly to the companion, so these routes are keyed by companion alone.
 */
export function registerMessageRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, harness, quota } = deps;

  // Read the companion's transcript (oldest-first).
  app.get(
    '/companions/:companionId/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const messages = await memory.getRecentMessages(companion.id, 200);
      return reply.send({ messages });
    },
  );

  // Send a message and stream the companion's reply (SSE).
  app.post(
    '/companions/:companionId/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = sendMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'message content is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      // Daily token cap: refuse before spending, so the wall is a clean 429 (no
      // partial SSE). Turn-based chat means there's nothing in flight to outrun.
      const overCap = await overCapGuard(quota, request.userId!);
      if (overCap) {
        return reply.code(429).send({ error: overCap });
      }

      await streamSse(
        reply,
        harness.runTurn({
          companion,
          userContent: parsed.data.content,
          ownerId: request.userId!,
        }),
      );
    },
  );
}

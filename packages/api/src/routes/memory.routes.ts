import type {
  EpisodicConversationSummary,
  EpisodicMemorySection,
  MemorySnapshotDto,
} from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

/**
 * Read-only memory browser (companionmemory.md). Exposes what a companion
 * "holds", grouped by memory kind. Phase 0 has only the episodic transcript;
 * semantic (P1) and procedural (P3) surface as planned-but-empty sections so the
 * full knowledge-base shape is visible before the stores exist.
 */
export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory } = deps;

  // List a companion's conversations (newest-first) for the episodic browser.
  app.get(
    '/companions/:companionId/conversations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const conversations = await memory.listConversations(companion.id);
      return reply.send({ conversations });
    },
  );

  // A sectioned snapshot of everything the companion holds.
  app.get(
    '/companions/:companionId/memory',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }

      const conversations = await memory.listConversations(companion.id);
      const summaries: EpisodicConversationSummary[] = await Promise.all(
        conversations.map(async (conversation) => ({
          id: conversation.id,
          createdAt: conversation.createdAt,
          messageCount: await memory.countMessages(conversation.id),
        })),
      );
      const messageCount = summaries.reduce((total, c) => total + c.messageCount, 0);

      const episodic: EpisodicMemorySection = {
        status: 'available',
        conversationCount: summaries.length,
        messageCount,
        conversations: summaries,
      };

      const snapshot: MemorySnapshotDto = {
        identity: companion,
        episodic,
        semantic: { status: 'not_implemented', plannedPhase: 'Phase 1' },
        procedural: { status: 'not_implemented', plannedPhase: 'Phase 3' },
      };
      return reply.send({ memory: snapshot });
    },
  );
}

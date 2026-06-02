import { sendMessageSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { streamSse } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}
interface ConversationParams extends CompanionParams {
  readonly conversationId: string;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, harness } = deps;

  // Start a new conversation with an owned companion.
  app.post(
    '/companions/:companionId/conversations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const conversation = await memory.createConversation(companion.id);
      return reply.code(201).send({ conversation });
    },
  );

  // Read a conversation transcript (oldest-first).
  app.get(
    '/companions/:companionId/conversations/:conversationId/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, conversationId } = request.params as ConversationParams;
      const ok = await isOwnedConversation(deps, request.userId!, companionId, conversationId);
      if (!ok) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const messages = await memory.getRecentMessages(conversationId, 200);
      return reply.send({ messages });
    },
  );

  // Send a message and stream the companion's reply (SSE).
  app.post(
    '/companions/:companionId/conversations/:conversationId/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, conversationId } = request.params as ConversationParams;
      const parsed = sendMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'message content is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const conversation = await memory.getConversation(conversationId);
      if (!conversation || conversation.companionId !== companion.id) {
        return reply.code(404).send({ error: 'conversation not found' });
      }

      await streamSse(
        reply,
        harness.runTurn({
          companion,
          conversationId,
          userContent: parsed.data.content,
        }),
      );
    },
  );
}

/** Verify the conversation belongs to a companion owned by this user. */
async function isOwnedConversation(
  deps: AppDeps,
  userId: string,
  companionId: string,
  conversationId: string,
): Promise<boolean> {
  const companion = await deps.identity.getCompanion(companionId, userId);
  if (!companion) return false;
  const conversation = await deps.memory.getConversation(conversationId);
  return conversation !== null && conversation.companionId === companion.id;
}

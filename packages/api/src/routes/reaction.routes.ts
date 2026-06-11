import { addReactionSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface ReactionParams {
  readonly companionId: string;
  readonly messageId: string;
}

interface ReactionDeleteParams extends ReactionParams {
  readonly emoji: string;
}

/**
 * User emoji reactions on the companion's messages (companion-reactions.md §8).
 * The reaction is the addressed reward signal the companion later learns from
 * (Phase C); here it is only *persisted and delivered*. Both handlers persist,
 * publish the live `reaction_*` event over the standing channel (§6), and return
 * immediately — the inline value-created read runs after the response (Phase C),
 * so a reaction never blocks the UI.
 *
 * Reactor is always `user` on these routes; the companion's own reactions are
 * emitted from inside the agent loop, not the API (§5).
 */
export function registerReactionRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, reactions, reactionLearner, eventBus, logger } = deps;

  // Add a reaction to a message.
  app.post(
    '/companions/:companionId/messages/:messageId/reactions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, messageId } = request.params as ReactionParams;
      const parsed = addReactionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a single emoji is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      // The reaction must attach to a message that belongs to THIS companion — the
      // unique index can't enforce that (it omits companion_id), so check ownership
      // before writing (companion-reactions.md §8).
      const message = await memory.getMessageById(companion.id, messageId);
      if (!message) {
        return reply.code(404).send({ error: 'message not found' });
      }
      try {
        const { inserted } = await reactions.add(
          companion.id,
          messageId,
          'user',
          parsed.data.emoji,
        );
        // Fire the live event and the learning ONLY when this call actually created
        // the reaction. A re-tap / double-POST of the same emoji is a no-op: no
        // duplicate broadcast, and no second (billed) read nudging the weights again.
        if (inserted) {
          eventBus.publish(companion.id, {
            type: 'reaction_added',
            messageId,
            reactor: 'user',
            emoji: parsed.data.emoji,
          });
          // The reaction is the addressed reward signal (companion-reactions.md §4):
          // read its value and learn AFTER responding — fire-and-forget, self-catching,
          // billed to stamina — so it never blocks the tap. Only an *added* reaction
          // teaches; removing one doesn't.
          reactionLearner.learn(companion.id, messageId, parsed.data.emoji);
        }
        return reply.send({ ok: true });
      } catch (error) {
        logger.error('failed to add reaction', {
          operation: 'reactions.add',
          companionId,
          messageId,
          error,
        });
        return reply.code(500).send({ error: 'failed to add reaction' });
      }
    },
  );

  // Remove a reaction. Idempotent: removing one that's already gone is a clean 200,
  // and only an actual deletion publishes a `reaction_removed` (so surfaces don't
  // see a spurious event for a no-op). The store scopes the delete by companion, so
  // a foreign message id simply removes nothing.
  app.delete(
    '/companions/:companionId/messages/:messageId/reactions/:emoji',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, messageId, emoji } = request.params as ReactionDeleteParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      try {
        const removed = await reactions.remove(companion.id, messageId, 'user', emoji);
        if (removed) {
          eventBus.publish(companion.id, {
            type: 'reaction_removed',
            messageId,
            reactor: 'user',
            emoji,
          });
        }
        return reply.send({ ok: true });
      } catch (error) {
        logger.error('failed to remove reaction', {
          operation: 'reactions.remove',
          companionId,
          messageId,
          error,
        });
        return reply.code(500).send({ error: 'failed to remove reaction' });
      }
    },
  );
}

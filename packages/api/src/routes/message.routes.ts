import type { GrowthService, Logger } from '@cobble/core';
import { sendMessageSchema, type ChatStreamEvent } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { overCapGuard } from '../quota-guard.js';
import { streamSse } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}

/**
 * Wrap a turn's event stream so the Phase-5 growth recompute runs as its TAIL,
 * INSIDE the still-open SSE stream. The recompute is token-free and runs only
 * after the reply's `done` has already streamed — so it never delays the answer,
 * just the stream's close. Crossing a band posts an in-character reflection; we
 * emit it here as a `reflection` event carrying the persisted message, so the note
 * is felt in place rather than waiting for the next transcript fetch. Best-effort:
 * a recompute failure is logged and never breaks the turn that already streamed.
 */
async function* withGrowthReflections(
  inner: AsyncIterable<ChatStreamEvent>,
  growth: GrowthService,
  companionId: string,
  logger: Logger,
): AsyncGenerator<ChatStreamEvent> {
  yield* inner;
  try {
    const { reflections } = await growth.recompute(companionId);
    for (const message of reflections) {
      yield { type: 'reflection', message };
    }
  } catch (error) {
    logger.error('post-turn growth recompute failed', {
      operation: 'growth.recompute',
      companionId,
      error,
    });
  }
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
  const { identity, memory, harness, quota, consolidation, presence, motivation, growth, logger } =
    deps;

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
      // Opening the transcript is a "return" — nudge the motivation engine so it
      // can offer something on arrival (P4 lazy trigger). Fire-and-forget; the
      // engine's gate decides whether to act (and stays idle if not).
      motivation.request(companion.id);
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
      // The user is here and acting — mark presence active (P4 environment signal).
      presence.recordActivity(companion.id);
      // Stamina wallet: refuse before spending, so the wall is a clean 429 (no
      // partial SSE). Turn-based chat means there's nothing in flight to outrun.
      const overCap = await overCapGuard(quota, companion.id);
      if (overCap) {
        return reply.code(429).send({ error: overCap });
      }
      // The companion learns like a person, but the sensing now lives INSIDE the
      // agent loop (Phase 4.2): the harness reads the user's mood every turn and,
      // when a self-directed act is awaiting a reaction, lets the *change* in mood
      // nudge the served drive's weight. Nothing to do here on the hot path — it
      // runs after the reply streams, so it can never block chat.
      // Growth (P5) recomputes as the tail of THIS stream: the turn may have
      // crossed a band (a new tool used, a fact consolidated), and any reflection
      // is streamed in place (`reflection` event) so it's felt now, not on the
      // next transcript fetch. The recompute is token-free and runs after `done`,
      // so it never delays the reply — only the stream's close. Idempotent.
      await streamSse(
        reply,
        withGrowthReflections(
          harness.runTurn({
            companion,
            userContent: parsed.data.content,
            ownerId: request.userId!,
          }),
          growth,
          companion.id,
          logger,
        ),
        logger,
      );

      // The turn's user + assistant messages are now persisted. Nudge the
      // background reflection pass (coalesced + cap-gated + serial in the runner;
      // it only consolidates once enough new turns accrue). Fire-and-forget: the
      // response is already streamed, so this must never affect the turn.
      consolidation.request(companion.id);
      // Also nudge the motivation engine (P4): the user just engaged, so this is
      // both an activity tick and a chance to line up post-conversation work. The
      // engine idles while the user is active; it acts once they go idle/away.
      motivation.request(companion.id);
    },
  );
}

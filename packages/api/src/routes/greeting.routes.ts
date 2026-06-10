import type { GreetingService, Logger } from '@cobble/core';
import { companionUnavailableNotice, type ChatStreamEvent } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { streamSse } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}

/**
 * Stream a greeting decision as Server-Sent Events (Phase 14, companion-greeting.md
 * §7). The companion senses the arrival (token-free), and when it decides to greet
 * it emits a `composing` cue — so the client shows a typing indicator within a beat
 * — then the voiced greeting lands as `done`. When the gate stays quiet the stream
 * closes with no events (the correct, silent outcome). The arrival clock is stamped
 * in `finally` regardless, so an idle return doesn't re-greet on the next check.
 *
 * Accepted race — a rare double-greet. `prepare` (reads `last_seen_at`) and
 * `markSeen` (writes it) are not atomic, and the gap between them spans the whole
 * `compose` LLM call (seconds). Two arrival checks that don't share the client's
 * in-memory `greetingRef` guard can both read the same stale clock and both greet:
 *   - a refresh *during* compose (old page's guard is torn down, new page remounts);
 *   - two tabs / windows (each has its own guard);
 *   - two devices or surfaces on the one cloud companion;
 *   - an SSE reconnect/retry while the first request is still draining.
 * We accept it: it needs near-simultaneous multi-client arrivals, the worst outcome
 * is one duplicate greeting (no corruption), and `greetingRef` covers the common
 * single-tab case. Closing it would need a server-side compare-and-set on `markSeen`
 * (stamp only if `last_seen_at` still equals the value `prepare` observed) or a
 * `SELECT ... FOR UPDATE` around read+decide+stamp — deferred until it's worth it.
 */
async function* greetingEvents(
  greeting: GreetingService,
  companionId: string,
  ownerId: string,
  logger: Logger,
): AsyncGenerator<ChatStreamEvent> {
  try {
    const plan = await greeting.prepare(companionId, ownerId);
    if (plan.act) {
      yield { type: 'composing' };
      const result = await greeting.compose(companionId, plan);
      // A failed voicing is an honest, transient error — not a (misleading)
      // greeting and not a recorded outcome (companion-greeting.md §4).
      yield result.ok
        ? { type: 'done', message: result.message }
        : { type: 'error', message: companionUnavailableNotice() };
    }
  } catch (error) {
    logger.error('greeting stream failed', {
      operation: 'greeting.stream',
      companionId,
      error,
    });
    yield { type: 'error', message: companionUnavailableNotice() };
  } finally {
    try {
      await greeting.markSeen(companionId);
    } catch (error) {
      logger.error('greeting markSeen failed', {
        operation: 'greeting.markSeen',
        companionId,
        error,
      });
    }
  }
}

/**
 * The arrival-greeting endpoint (Phase 14). The web client opens this on mount and
 * on tab-return; the server decides whether to greet and streams the result. POST
 * (not GET) because it has side effects — it can spend stamina and write a turn.
 */
export function registerGreetingRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, greeting, logger } = deps;

  app.post(
    '/companions/:companionId/greeting',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      // Owner-scope the arrival (invariant #5) before the service uses the unscoped
      // background lookup for the full record.
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      await streamSse(
        reply,
        greetingEvents(greeting, companion.id, request.userId!, logger),
        logger,
      );
    },
  );
}

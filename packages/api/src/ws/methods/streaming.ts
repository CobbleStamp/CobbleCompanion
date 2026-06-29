import { type GreetingService, type GrowthService, type Logger } from '@cobble/core';
import {
  companionUnavailableNotice,
  sendMessageSchema,
  type ChatStreamEvent,
  type CompanionDto,
} from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { confirmProposal } from '../../proposals/confirm-proposal.js';
import { overCapGuard } from '../../quota-guard.js';
import { SUPERSEDED_CLOSE } from '../connection.js';
import type { WsCallContext, WsMethods } from '../dispatch.js';
import { requireEmbodiment } from '../fencing.js';
import { companionOf, ConflictError, NotFoundError, OverCapError, parseParams } from './helpers.js';

const confirmParams = z.object({ proposalId: z.string().uuid() });

/**
 * Streaming methods (mirror the SSE routes): the turn (`messages.send`), the arrival
 * greeting (`greeting.stream`), and `proposals.confirm`. Each pushes ChatStreamEvent
 * chunks via `ctx.emit` (correlated to the request id) and resolves with a terminal
 * result. All three can produce a turn, so they run through the connection's serial
 * chain (D2′) — a companion never runs two agent loops at once.
 */
export function streamingMethods(deps: AppDeps): WsMethods {
  const {
    identity,
    memory,
    harness,
    quota,
    proposals,
    leads,
    tools,
    toolCallLog,
    procedural,
    greeting,
    growth,
    consolidation,
    motivation,
    presence,
    embodiment,
  } = deps;

  /** Resolve the embodied companion as a DTO (for harness calls) — fenced. Carries the
   *  ULID `connectionId` + `claimSeq` so the turn can re-check the exact lease
   *  mid-loop (the long-turn fence). */
  async function embodiedCompanion(
    ctx: WsCallContext,
  ): Promise<{ id: string; dto: CompanionDto; connectionId: string; claimSeq: number }> {
    const binding = await requireEmbodiment(embodiment, ctx);
    const dto = await identity.getCompanion(binding.companionId, ctx.userId);
    if (!dto) {
      throw new NotFoundError('companion not found');
    }
    return {
      id: binding.companionId,
      dto,
      connectionId: binding.connectionId,
      claimSeq: binding.claimSeq,
    };
  }

  /** The mid-turn embodiment fence handed to the harness: re-reads the DB claim so a
   *  turn already running self-ends if a newer connection took the room (§5.2). Matches
   *  the exact claim (connectionId + claimSeq) so a recurred ULID can't revive a
   *  stale fence. */
  function leaseGuard(
    companionId: string,
    connectionId: string,
    claimSeq: number,
  ): () => Promise<boolean> {
    return () => embodiment.holds(companionId, connectionId, claimSeq);
  }

  /**
   * Drive a turn stream to completion, emitting each chunk. Returns the harness's
   * terminal signal: true = the turn stood down mid-loop because a newer connection
   * force-claimed the companion (the user moved rooms). The caller yields the room.
   */
  async function emitAll(
    ctx: WsCallContext,
    stream: AsyncGenerator<ChatStreamEvent, boolean | void>,
  ): Promise<boolean> {
    try {
      let next = await stream.next();
      while (!next.done) {
        ctx.emit(next.value);
        next = await stream.next();
      }
      return next.value === true;
    } catch (error) {
      // Driving the generator by hand (to capture its terminal return value) loses
      // the automatic `.return()` that `for await` performs on early exit. Forward
      // termination so the harness generator's `finally` still runs — ending its
      // trace, debiting metered tokens, and tearing down any in-flight LLM stream —
      // then re-throw for the dispatcher to surface as a client-safe error.
      await stream.return(false).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The companion moved rooms mid-turn: tell this (now superseded) client and close
   * the socket at once, rather than lingering until the next heartbeat notices the
   * lost claim (deliver-scalability.md §5.2). Idempotent with the heartbeat's own
   * self-fence — a second close is a no-op.
   */
  function yieldRoom(ctx: WsCallContext, companionId: string): void {
    ctx.connection.pushEvent('embodiment.superseded', { companionId });
    ctx.connection.close(SUPERSEDED_CLOSE, 'superseded');
  }

  return {
    'messages.send': async (ctx, params) => {
      const { content } = parseParams(sendMessageSchema, params, 'message content is required');
      const {
        id: companionId,
        dto: companion,
        connectionId,
        claimSeq,
      } = await embodiedCompanion(ctx);
      presence.recordActivity(companionId, { connectionId, claimSeq });
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      const superseded = await ctx.connection.runSerial(() =>
        emitAll(
          ctx,
          withGrowthReflections(
            harness.runTurn({
              companion,
              userContent: content,
              ownerId: ctx.userId,
              holdsLease: leaseGuard(companionId, connectionId, claimSeq),
            }),
            growth,
            companionId,
            ctx.logger,
          ),
        ),
      );
      // The user moved rooms mid-turn — yield the room and run NO post-turn nudges
      // (they belong to the live embodiment, on the new connection).
      if (superseded) {
        yieldRoom(ctx, companionId);
        return { done: true };
      }
      // Post-turn nudges (fire-and-forget; the reply already streamed).
      consolidation.request(companionId);
      motivation.request(companionId);
      return { done: true };
    },

    'greeting.stream': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      await ctx.connection.runSerial(() =>
        emitAll(ctx, greetingEvents(greeting, companionId, ctx.userId, ctx.logger)),
      );
      return { done: true };
    },

    'proposals.confirm': async (ctx, params) => {
      const { proposalId } = parseParams(confirmParams, params, 'a proposal id is required');
      const {
        id: companionId,
        dto: companion,
        connectionId,
        claimSeq,
      } = await embodiedCompanion(ctx);
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      // The use case (claim → dispatch → bookkeeping → outcome row) is a transport-free
      // domain service; the handler owns only fencing/over-cap above and the live-stream
      // re-entry below (the gold-reference layering, discord.routes.ts).
      const confirmation = await confirmProposal(
        { proposals, tools, toolCallLog, procedural, leads, memory, logger: ctx.logger },
        { companionId, ownerId: ctx.userId, proposalId },
      );
      if (confirmation.outcome === 'not_pending') {
        throw new ConflictError('proposal is no longer pending');
      }
      const { proposal, toolResult, outcomeRow } = confirmation;

      // A chat-origin approval re-enters the agent loop with the tool outcome (streamed);
      // an explore/autonomous one is self-directed, so the motivation engine drives next.
      if (proposal.origin === 'chat') {
        const superseded = await ctx.connection.runSerial(() =>
          emitAll(
            ctx,
            harness.continueAfterApproval({
              companion,
              ownerId: ctx.userId,
              outcome: toolResult.content,
              holdsLease: leaseGuard(companionId, connectionId, claimSeq),
            }),
          ),
        );
        if (superseded) {
          yieldRoom(ctx, companionId);
        }
        return { done: true };
      }
      motivation.request(companionId);
      if (outcomeRow) {
        ctx.emit({ type: 'done', message: outcomeRow } satisfies ChatStreamEvent);
      }
      return { done: true };
    },
  };
}

/** The Phase-5 growth recompute as the turn stream's tail (token-free; idempotent).
 *  Forwards the turn's superseded signal so the caller can yield the room. */
async function* withGrowthReflections(
  inner: AsyncGenerator<ChatStreamEvent, boolean>,
  growth: GrowthService,
  companionId: string,
  logger: Logger,
): AsyncGenerator<ChatStreamEvent, boolean> {
  const superseded = yield* inner;
  // Stood down mid-turn: skip the growth recompute write too — the live turn on the
  // new connection owns this companion's reflections now.
  if (superseded) {
    return true;
  }
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
  return false;
}

/** The arrival-greeting decision stream (companion-greeting.md §7). */
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
      yield result.ok
        ? { type: 'done', message: result.message }
        : { type: 'error', message: companionUnavailableNotice() };
    }
  } catch (error) {
    logger.error('greeting stream failed', { operation: 'greeting.stream', companionId, error });
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

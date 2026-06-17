import { dispatchTool, type GreetingService, type GrowthService, type Logger } from '@cobble/core';
import {
  companionUnavailableNotice,
  sendMessageSchema,
  type ChatStreamEvent,
  type CompanionDto,
  type MessageDto,
} from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { overCapGuard } from '../../quota-guard.js';
import type { WsCallContext, WsMethods } from '../dispatch.js';
import { companionOf, ConflictError, NotFoundError, OverCapError, parseParams } from './helpers.js';

const confirmParams = z.object({ proposalId: z.string().min(1) });

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
    logger,
  } = deps;

  /** Resolve the embodied companion as a DTO (for harness calls) — fenced. */
  async function embodiedCompanion(ctx: WsCallContext): Promise<{ id: string; dto: CompanionDto }> {
    const companionId = await companionOf(embodiment, ctx);
    const dto = await identity.getCompanion(companionId, ctx.userId);
    if (!dto) {
      throw new NotFoundError('companion not found');
    }
    return { id: companionId, dto };
  }

  async function emitAll(
    ctx: WsCallContext,
    stream: AsyncIterable<ChatStreamEvent>,
  ): Promise<void> {
    for await (const event of stream) {
      ctx.emit(event);
    }
  }

  return {
    'messages.send': async (ctx, params) => {
      const { content } = parseParams(sendMessageSchema, params, 'message content is required');
      const { id: companionId, dto: companion } = await embodiedCompanion(ctx);
      presence.recordActivity(companionId);
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      await ctx.connection.runSerial(() =>
        emitAll(
          ctx,
          withGrowthReflections(
            harness.runTurn({ companion, userContent: content, ownerId: ctx.userId }),
            growth,
            companionId,
            logger,
          ),
        ),
      );
      // Post-turn nudges (fire-and-forget; the reply already streamed).
      consolidation.request(companionId);
      motivation.request(companionId);
      return { done: true };
    },

    'greeting.stream': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      await ctx.connection.runSerial(() =>
        emitAll(ctx, greetingEvents(greeting, companionId, ctx.userId, logger)),
      );
      return { done: true };
    },

    'proposals.confirm': async (ctx, params) => {
      const { proposalId } = parseParams(confirmParams, params, 'a proposal id is required');
      const { id: companionId, dto: companion } = await embodiedCompanion(ctx);
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      // Atomic claim: only the call that flips pending→approved executes.
      const proposal = await proposals.markResolved(companionId, proposalId, 'approved');
      if (!proposal) {
        throw new ConflictError('proposal is no longer pending');
      }
      const result = await dispatchTool(
        tools,
        proposal.toolName,
        proposal.toolArgs,
        { companionId, ownerId: ctx.userId },
        logger,
        proposal.toolCallId ?? undefined,
      );
      try {
        await toolCallLog.record(companionId, proposal.toolName, proposal.toolArgs, result.content);
      } catch (error) {
        logger.error('failed to log approved tool call', {
          operation: 'proposals.confirm.log',
          companionId,
          proposalId,
          error,
        });
      }
      if (!result.isError) {
        try {
          await procedural.record(companionId, proposal.summary, [proposal.toolName]);
        } catch (error) {
          logger.error('failed to record procedural memory', {
            operation: 'proposals.confirm.procedural',
            companionId,
            proposalId,
            error,
          });
        }
        await advanceIngested(leads, companionId, proposal.leadId, proposalId, logger);
      }
      let outcomeRow: MessageDto | null = null;
      try {
        outcomeRow = await memory.appendMessage(companionId, 'assistant', result.content, {
          kind: 'tool_step',
          metadata: { toolName: proposal.toolName },
        });
      } catch (error) {
        logger.error('failed to record approved action row', {
          operation: 'proposals.confirm.row',
          companionId,
          proposalId,
          error,
        });
      }

      if (proposal.origin === 'chat') {
        await ctx.connection.runSerial(() =>
          emitAll(
            ctx,
            harness.continueAfterApproval({
              companion,
              ownerId: ctx.userId,
              outcome: result.content,
            }),
          ),
        );
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

/** Advance an explore-origin lead to `ingested` (best-effort). */
async function advanceIngested(
  leads: AppDeps['leads'],
  companionId: string,
  leadId: string | null,
  proposalId: string,
  logger: Logger,
): Promise<void> {
  if (!leadId) return;
  try {
    await leads.markStatus(companionId, leadId, 'ingested');
  } catch (error) {
    logger.error('failed to advance lead lifecycle', {
      operation: 'proposals.confirm.advanceLead',
      companionId,
      proposalId,
      leadId,
      error,
    });
  }
}

/** The Phase-5 growth recompute as the turn stream's tail (token-free; idempotent). */
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

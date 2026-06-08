/**
 * Approval-queue routes (Phase 3, propose→approve — architecture.md §4.4). The
 * companion never executes a consequential action without explicit approval:
 * effectful tool calls are held as proposals, listed here, and only run when the
 * user confirms. Confirm resolves the proposal exactly once (atomic claim), then
 * executes the held call, logs it, and records the outcome to the transcript.
 * All routes are owner-scoped via the companion-ownership check.
 */

import type { ChatStreamEvent, MessageDto, ProposalDto, ProposalStatus } from '@cobble/shared';
import { dispatchTool } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { overCapGuard } from '../quota-guard.js';
import { streamSse } from '../sse.js';

interface CompanionParams {
  readonly companionId: string;
}

interface ProposalParams extends CompanionParams {
  readonly proposalId: string;
}

export function registerProposalRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const {
    identity,
    harness,
    memory,
    proposals,
    leads,
    tools,
    toolCallLog,
    procedural,
    quota,
    motivation,
    logger,
  } = deps;

  /**
   * Close an explore-origin lead's lifecycle when its proposal resolves. A
   * chat-origin proposal has no lead (`leadId` null) — nothing to advance.
   * Best-effort: this is bookkeeping, so a failure here must never fail an action
   * the user already approved/rejected (logging.md).
   */
  async function advanceLead(
    companionId: string,
    leadId: string | null,
    status: 'ingested' | 'discarded',
    proposalId: string,
  ): Promise<void> {
    if (!leadId) return;
    try {
      await leads.markStatus(companionId, leadId, status);
    } catch (error) {
      logger.error('failed to advance lead lifecycle', {
        operation: 'proposals.advanceLead',
        companionId,
        proposalId,
        leadId,
        status,
        error,
      });
    }
  }

  // The pending approval queue (the surface polls this while any are pending).
  app.get(
    '/companions/:companionId/proposals',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const pending = await proposals.listPending(companion.id);
      return reply.send({ proposals: pending.map(toProposalDto) });
    },
  );

  // Approve a held action: resolve it exactly once, then execute + log it.
  app.post(
    '/companions/:companionId/proposals/:proposalId/confirm',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, proposalId } = request.params as ProposalParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      // Executing the action (and reading its result) spends tokens downstream,
      // so it's gated by the same stamina wallet as a chat turn.
      const overCap = await overCapGuard(quota, companion.id);
      if (overCap) {
        return reply.code(429).send({ error: overCap });
      }
      // Atomic claim: only the call that flips pending→approved proceeds, so a
      // double-confirm cannot double-execute (architecture.md §4.4 / §4.8).
      const proposal = await proposals.markResolved(companion.id, proposalId, 'approved');
      if (!proposal) {
        return reply.code(409).send({ error: 'proposal is no longer pending' });
      }
      const ctx = { companionId: companion.id, ownerId: request.userId! };
      const result = await dispatchTool(
        tools,
        proposal.toolName,
        proposal.toolArgs,
        ctx,
        logger,
        proposal.toolCallId ?? undefined,
      );
      // Every tool call is logged (the DoD). Best-effort: a log hiccup must not
      // fail an action the user already approved (logging.md).
      try {
        await toolCallLog.record(
          companion.id,
          proposal.toolName,
          proposal.toolArgs,
          result.content,
        );
      } catch (error) {
        logger.error('failed to log approved tool call', {
          operation: 'proposals.confirm.log',
          companionId: companion.id,
          proposalId,
          error,
        });
      }
      // Seed procedural memory: a successfully approved action becomes a learned,
      // reusable workflow (Phase 3 seed — browse-only; retrieval is Phase 5). Only
      // a real success counts — failures are surfaced as data (busy queue, bad
      // args), so seeding on `result.isError` would teach a workflow for an action
      // that never happened (§4.7).
      // Best-effort: a failure here must not fail the action (logging.md).
      if (!result.isError) {
        try {
          await procedural.record(companion.id, proposal.summary, [proposal.toolName]);
        } catch (error) {
          logger.error('failed to record procedural memory', {
            operation: 'proposals.confirm.procedural',
            companionId: companion.id,
            proposalId,
            error,
          });
        }
        // Close the originating lead's lifecycle: a successfully ingested lead
        // leaves the reading list as 'ingested' (it was stranded at 'read'
        // otherwise — M2). Only on real success; a failed ingest stays 'read' so
        // it isn't recorded as read-into-memory when nothing was.
        await advanceLead(companion.id, proposal.leadId, 'ingested', proposalId);
      }
      // The approved action's outcome becomes a friendly transcript row (a UI
      // record, filtered out of the model's context). Best-effort persist: the
      // chat continuation injects the outcome into context regardless (logging.md).
      let outcomeRow: MessageDto | null = null;
      try {
        outcomeRow = await memory.appendMessage(companion.id, 'assistant', result.content, {
          kind: 'tool_step',
          metadata: { toolName: proposal.toolName },
        });
      } catch (error) {
        logger.error('failed to record approved action row', {
          operation: 'proposals.confirm.row',
          companionId: companion.id,
          proposalId,
          error,
        });
      }

      // Post-approval "what next" depends on the proposal's ORIGIN (§4.4/§4.5):
      // - chat: a present conversational partner — RE-ENTER the loop so the
      //   companion narrates the result and continues the ask ("…and summarize it").
      // - explore/autonomous: self-directed work with no live ask to continue.
      //   Deciding the next move is the motivation engine's agenda-setting job, not
      //   a confirm-route reflex (and per-approval re-entry is incoherent for a
      //   batch). So nudge the engine and stream just the outcome — no LLM turn.
      if (proposal.origin === 'chat') {
        await streamSse(
          reply,
          harness.continueAfterApproval({
            companion,
            ownerId: request.userId!,
            outcome: result.content,
          }),
          logger,
        );
        return;
      }
      motivation.request(companion.id);
      await streamSse(reply, outcomeStream(outcomeRow), logger);
      return;
    },
  );

  // Decline a held action: resolve it rejected; nothing executes.
  app.post(
    '/companions/:companionId/proposals/:proposalId/reject',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, proposalId } = request.params as ProposalParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const proposal = await proposals.markResolved(companion.id, proposalId, 'rejected');
      if (!proposal) {
        return reply.code(409).send({ error: 'proposal is no longer pending' });
      }
      // A declined explore proposal discards its lead: it leaves the reading list
      // and is never re-proposed (it was stranded at 'read' otherwise — M2).
      await advanceLead(companion.id, proposal.leadId, 'discarded', proposalId);
      return reply.code(204).send();
    },
  );
}

/**
 * Minimal SSE for a self-directed (explore/autonomous) approval: emit just the
 * persisted outcome row as a terminal `done`, so the client's stream consumer
 * resolves cleanly without an LLM continuation turn. Empty when the outcome row
 * failed to persist (the client falls back to a transcript refresh).
 */
async function* outcomeStream(row: MessageDto | null): AsyncGenerator<ChatStreamEvent> {
  if (row) {
    yield { type: 'done', message: row };
  }
}

/** Project a stored proposal to the wire DTO the surface renders. */
function toProposalDto(proposal: {
  id: string;
  toolName: string;
  summary: string;
  status: ProposalStatus;
  createdAt: Date;
}): ProposalDto {
  return {
    id: proposal.id,
    toolName: proposal.toolName,
    summary: proposal.summary,
    status: proposal.status,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/**
 * Approval-queue routes (Phase 3, propose→approve — architecture.md §4.4). The
 * companion never executes a consequential action without explicit approval:
 * effectful tool calls are held as proposals, listed here, and only run when the
 * user confirms. Confirm resolves the proposal exactly once (atomic claim), then
 * executes the held call, logs it, and records the outcome to the transcript.
 * All routes are owner-scoped via the companion-ownership check.
 */

import type { ProposalDto, ProposalStatus } from '@cobble/shared';
import { dispatchTool } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { overCapGuard } from '../quota-guard.js';

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
  const { identity, memory, proposals, tools, toolCallLog, procedural, quota, logger } = deps;

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
      // so it's gated by the same daily cap as a chat turn.
      const overCap = await overCapGuard(quota, request.userId!);
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
        await toolCallLog.record(companion.id, proposal.toolName, proposal.toolArgs, result.content);
      } catch (error) {
        logger.error('failed to log approved tool call', {
          operation: 'proposals.confirm.log',
          companionId: companion.id,
          proposalId,
          error,
        });
      }
      // Seed procedural memory: a successfully approved action becomes a learned,
      // reusable workflow (Phase 3 seed — browse-only; retrieval is Phase 5).
      // Best-effort: a failure here must not fail the action (logging.md).
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
      // Record the outcome to the transcript so the conversation reflects it
      // (the tool's result content is already a user-facing sentence).
      const message = await memory.appendMessage(companion.id, 'assistant', result.content);
      return reply.send({ message });
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
      return reply.code(204).send();
    },
  );
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

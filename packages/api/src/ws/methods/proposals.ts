import { toProposalDto } from '@cobble/core';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, ConflictError, parseParams } from './helpers.js';

const rejectParams = z.object({ proposalId: z.string().uuid() });

/**
 * Approval queue — list + reject (mirrors proposal.routes; `proposals.confirm` is
 * streaming, in streaming.ts). Rejecting resolves the proposal once and discards
 * its originating lead.
 */
export function proposalMethods(deps: AppDeps): WsMethods {
  const { proposals, leads, embodiment, logger } = deps;

  /** Close an explore-origin lead when its proposal resolves (best-effort). */
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

  return {
    'proposals.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const pending = await proposals.listPending(companionId);
      return { proposals: pending.map(toProposalDto) };
    },
    'proposals.reject': async (ctx, params) => {
      const { proposalId } = parseParams(rejectParams, params, 'a proposal id is required');
      const companionId = await companionOf(embodiment, ctx);
      const proposal = await proposals.markResolved(companionId, proposalId, 'rejected');
      if (!proposal) {
        throw new ConflictError('proposal is no longer pending');
      }
      await advanceLead(companionId, proposal.leadId, 'discarded', proposalId);
      return { ok: true };
    },
  };
}

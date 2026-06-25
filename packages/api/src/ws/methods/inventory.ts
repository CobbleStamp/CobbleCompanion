import { runExploreBurst, toProposalDto } from '@cobble/core';
import type { LeadDto, ProcedureDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf } from './helpers.js';

/** Reading list + explore + procedural memory (mirrors inventory.routes). */
export function inventoryMethods(deps: AppDeps): WsMethods {
  const { leads, proposals, procedural, tools, embodiment } = deps;
  return {
    'leads.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const found = await leads.listByStatus(companionId, ['new', 'read']);
      return { leads: found.map(toLeadDto) };
    },
    'leads.clear': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const cleared = await leads.clear(companionId);
      ctx.logger.info('reading list cleared', {
        operation: 'ws.leads.clear',
        companionId,
        cleared,
      });
      return { cleared };
    },
    explore: async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const created = await runExploreBurst(
        { leads, proposals, tools },
        { companionId, origin: 'explore' },
      );
      return { proposals: created.map(toProposalDto) };
    },
    'procedures.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const rows = await procedural.list(companionId, 50);
      const procedures: ProcedureDto[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        steps: row.steps,
        createdAt: row.createdAt.toISOString(),
      }));
      return { procedures };
    },
  };
}

function toLeadDto(lead: {
  id: string;
  url: string;
  why: string | null;
  status: LeadDto['status'];
  createdAt: Date;
}): LeadDto {
  return {
    id: lead.id,
    url: lead.url,
    why: lead.why,
    status: lead.status,
    createdAt: lead.createdAt.toISOString(),
  };
}

/**
 * Reading-list + procedural-memory routes (Phase 3). The lead inventory is the
 * companion's reading list (URLs it discovered while reading); `explore` is the
 * user-triggered "go through your reading list" action — it proposes remembering
 * the next leads (held for approval), the same loop the Phase 4 motivation engine
 * will run on idle. Procedural memory lists learned workflows. All owner-scoped.
 */

import { runExploreBurst, toProposalDto } from '@cobble/core';
import type { LeadDto, ProcedureDto } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, leads, proposals, procedural, tools } = deps;

  // The reading list: leads discovered but not yet acted on.
  app.get('/companions/:companionId/leads', { preHandler: requireAuth }, async (request, reply) => {
    const { companionId } = request.params as CompanionParams;
    const companion = await identity.getCompanion(companionId, request.userId!);
    if (!companion) {
      return reply.code(404).send({ error: 'companion not found' });
    }
    const found = await leads.listByStatus(companion.id, ['new', 'read']);
    return reply.send({ leads: found.map(toLeadDto) });
  });

  // "Go through your reading list": take the next few new leads and propose
  // remembering them (held for approval). Nothing is ingested without confirm.
  app.post(
    '/companions/:companionId/explore',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      // The same burst the Phase 4 motivation engine runs on idle — here triggered
      // on the user's command, so the proposals are stamped `explore` origin.
      const created = await runExploreBurst(
        { leads, proposals, tools },
        { companionId: companion.id, origin: 'explore' },
      );
      return reply.send({ proposals: created.map(toProposalDto) });
    },
  );

  // Learned workflows (the procedural-memory browse view).
  app.get(
    '/companions/:companionId/procedures',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const rows = await procedural.list(companion.id, 50);
      const procedures: ProcedureDto[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        steps: row.steps,
        createdAt: row.createdAt.toISOString(),
      }));
      return reply.send({ procedures });
    },
  );
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

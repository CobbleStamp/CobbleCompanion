/**
 * Usage route — a companion's STAMINA wallet balance, polled by the web client's
 * live indicator (architecture.md §4.8). Companion-scoped: stamina is the
 * user-initiated half of that companion's vitality, so the meter is per companion
 * (a user with several companions sees each one's stamina separately). The wallet
 * refills only by feeding, so the remaining balance is the whole reading. Owner-scoped
 * via the companion-ownership check.
 */

import type { UsageDto } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  app.get('/companions/:companionId/usage', { preHandler: requireAuth }, async (request, reply) => {
    const { companionId } = request.params as CompanionParams;
    const companion = await deps.identity.getCompanion(companionId, request.userId!);
    if (!companion) {
      return reply.code(404).send({ error: 'companion not found' });
    }
    const dto: UsageDto = { balanceTokens: await deps.quota.getBalance(companion.id) };
    return reply.send({ usage: dto });
  });
}

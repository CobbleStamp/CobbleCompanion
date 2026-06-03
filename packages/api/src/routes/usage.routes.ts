/**
 * Usage route — the signed-in user's daily token-budget standing, polled by the
 * web client's live usage indicator (architecture.md token budget). Account-
 * scoped (not companion-scoped): the cap is per user across all their companions.
 */

import type { UsageDto } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  app.get('/usage', { preHandler: requireAuth }, async (request) => {
    const usage = await deps.quota.getUsage(request.userId!);
    const percentUsed =
      usage.capTokens > 0
        ? Math.min(100, Math.round((usage.usedTokens / usage.capTokens) * 100))
        : 0;
    const dto: UsageDto = {
      usedTokens: usage.usedTokens,
      capTokens: usage.capTokens,
      percentUsed,
      resetsAt: usage.resetsAt,
    };
    return { usage: dto };
  });
}

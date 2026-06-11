/**
 * Autonomous-activity routes (Phase 4) — the companion's self-directed initiatives
 * made visible. `GET /companions/:companionId/activity` is a READ-ONLY page of the
 * `proactive_outcomes` log (newest-first): each row is one burst the motivation
 * engine ran on its own — no approval gate, autonomy is autonomy — surfaced with
 * the report note it posted, the drive it served, the belief that drove it, and the
 * reward (the user's reaction). Keyset-paginated by `seq`. Owner-scoped.
 */

import type { ProactiveActivityDto, ProactiveOutcomeDto } from '@cobble/shared';
import type { ProactiveOutcomeDetail } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

interface ActivityQuery {
  readonly limit?: string;
  readonly before?: string;
}

/** Page size: default and hard cap (keeps a single query bounded). */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Coerce a positive-int query param, clamped to [1, max]; falls back on garbage. */
function clampInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return fallback;
  }
  return Math.min(n, max);
}

/** A keyset cursor: a positive integer `seq`, or undefined when absent/invalid. */
function parseCursor(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function registerProactiveActivityRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, rewards } = deps;

  app.get(
    '/companions/:companionId/activity',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }

      const query = request.query as ActivityQuery;
      const limit = clampInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const before = parseCursor(query.before);

      const [outcomes, stats] = await Promise.all([
        rewards.listDetailed(companion.id, limit, before),
        rewards.stats(companion.id),
      ]);

      // A full page implies there may be more; the next page starts before the
      // smallest seq we just returned (the list is seq-descending).
      const nextCursor =
        outcomes.length === limit ? (outcomes[outcomes.length - 1]?.seq ?? null) : null;

      const body: ProactiveActivityDto = {
        outcomes: outcomes.map(toDto),
        stats,
        nextCursor,
      };
      return reply.send(body);
    },
  );
}

function toDto(detail: ProactiveOutcomeDetail): ProactiveOutcomeDto {
  return {
    id: detail.id,
    seq: detail.seq,
    drive: detail.drive,
    driveSnapshot: detail.driveSnapshot,
    note: detail.noteContent,
    belief: detail.belief,
    sources: detail.sources,
    reward: detail.reward,
    resolved: detail.resolvedAt !== null,
    createdAt: detail.createdAt.toISOString(),
  };
}

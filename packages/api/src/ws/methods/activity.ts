import type { ProactiveOutcomeDetail } from '@cobble/core';
import { z } from 'zod';
import type { ProactiveActivityDto, ProactiveOutcomeDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, parseParams } from './helpers.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const listParams = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.number().int().positive().optional(),
});

/** Autonomous-activity log (mirrors proactive-activity.routes) — keyset-paginated. */
export function activityMethods(deps: AppDeps): WsMethods {
  const { proactiveActivity, embodiment } = deps;
  return {
    'activity.list': async (ctx, params) => {
      const { limit = DEFAULT_LIMIT, before } = parseParams(
        listParams,
        params ?? {},
        'invalid activity query',
      );
      const companionId = await companionOf(embodiment, ctx);
      const [outcomes, stats] = await Promise.all([
        proactiveActivity.listDetailed(companionId, limit, before),
        proactiveActivity.stats(companionId),
      ]);
      const nextCursor =
        outcomes.length === limit ? (outcomes[outcomes.length - 1]?.seq ?? null) : null;
      const body: ProactiveActivityDto = { outcomes: outcomes.map(toDto), stats, nextCursor };
      return body;
    },
  };
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

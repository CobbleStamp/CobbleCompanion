/**
 * Growth & feeding routes (Phase 5, development-plan.md §3). The companion's
 * bond/growth made visible (`GET /growth` — lazily recomputes from substrate and
 * persists any transition) and the feeding economy (`POST /feed` — spends earned
 * treats to top up a vitality pool). All owner-scoped.
 */

import { feedSchema, type GrowthDto, type StaminaEnergyDto } from '@cobble/shared';
import { feed } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { buildBudget } from './vitality.js';

interface CompanionParams {
  readonly companionId: string;
}

/** The feed route's reply: the updated vitality meter + full growth standing. */
interface FeedResultDto {
  readonly budget: StaminaEnergyDto;
  readonly growth: GrowthDto;
}

export function registerGrowthRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, growth, growthStore, quota, energy, logger } = deps;

  // The companion's four-axis growth standing (lazily recomputes + persists).
  app.get(
    '/companions/:companionId/growth',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      return reply.send(await growth.snapshot(companion.id));
    },
  );

  // Give the companion a food: spends treats, tops up the favoured pool.
  app.post('/companions/:companionId/feed', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = feedSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a valid food (ration|spark|treat) is required' });
    }
    const { companionId } = request.params as CompanionParams;
    const companion = await identity.getCompanion(companionId, request.userId!);
    if (!companion) {
      return reply.code(404).send({ error: 'companion not found' });
    }
    const result = await feed(
      { growth: growthStore, quota, energy, logger },
      { companionId: companion.id, ownerId: request.userId!, food: parsed.data.food },
    );
    if (!result.ok) {
      // Can't afford it — a clean 409 so the client shows "not enough treats".
      return reply.code(409).send({ error: result.reason ?? 'cannot feed' });
    }
    const body: FeedResultDto = {
      budget: await buildBudget(quota, energy, request.userId!, companion.id),
      growth: await growth.snapshot(companion.id),
    };
    return reply.send(body);
  });
}

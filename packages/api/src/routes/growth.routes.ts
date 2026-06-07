/**
 * Growth & feeding routes (Phase 5, development-plan.md §3). The companion's
 * bond/growth made visible (`GET /growth` — a READ-ONLY snapshot of the live derived
 * standing; the mark advances + reflections post only post-turn, inline on the message stream)
 * and the feeding economy (`POST /feed` — consumes one food from the user's pantry to
 * refill a vitality wallet). All owner-scoped.
 */

import { feedSchema, type FeedResultDto } from '@cobble/shared';
import { feed } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { buildBudget } from './vitality.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerGrowthRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, growth, quota, energy, food, logger } = deps;

  // The companion's four-axis growth standing — read-only (the runner advances the
  // mark + posts reflections post-turn; a GET never mutates the transcript).
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

  // Read the user's food pantry — the Kitchen's supply (per user, spendable on any companion).
  app.get('/food', { preHandler: requireAuth }, async (request, reply) => {
    return reply.send({ food: await food.getPantry(request.userId!) });
  });

  // Feed the companion a food: consume one from the user's pantry, refill the wallet(s).
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
      { food, stamina: quota, energy, logger },
      { companionId: companion.id, userId: request.userId!, food: parsed.data.food },
    );
    if (!result.ok) {
      // Out of that food — a clean 409 so the client shows "out of <food>".
      return reply.code(409).send({ error: result.reason ?? 'cannot feed' });
    }
    const body: FeedResultDto = {
      budget: await buildBudget(quota, energy, companion.id),
      food: await food.getPantry(request.userId!),
    };
    return reply.send(body);
  });
}

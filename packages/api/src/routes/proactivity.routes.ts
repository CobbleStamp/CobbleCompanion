/**
 * Proactivity & vitality routes (Phase 4). The companion's two budget pools made
 * legible and user-controllable (architecture.md §4.8): GET the stamina/energy
 * meter, top up either pool (the simple feed control — the food/feeding economy
 * is Phase 5), and set the proactivity dial. All owner-scoped.
 */

import { setProactivityDialSchema, topUpSchema, type StaminaEnergyDto } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { buildBudget } from './vitality.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerProactivityRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, quota, energy } = deps;

  async function budget(userId: string, companionId: string): Promise<StaminaEnergyDto> {
    return buildBudget(quota, energy, userId, companionId);
  }

  // The vitality meter: stamina (user-initiated) + energy (self-initiated).
  app.get(
    '/companions/:companionId/budget',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      return reply.send(await budget(request.userId!, companion.id));
    },
  );

  // Feed a pool (the simple manual top-up). Returns the updated meter.
  app.post(
    '/companions/:companionId/budget/topup',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = topUpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'pool and a positive amount are required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      if (parsed.data.pool === 'stamina') {
        await quota.topUp(request.userId!, parsed.data.amount);
      } else {
        await energy.topUp(companion.id, parsed.data.amount);
      }
      return reply.send(await budget(request.userId!, companion.id));
    },
  );

  // Set the proactivity dial (off / gentle / active).
  app.patch(
    '/companions/:companionId/proactivity',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = setProactivityDialSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a valid dial (off|gentle|active) is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      await identity.setProactivityDial(companion.id, parsed.data.dial);
      return reply.send({ dial: parsed.data.dial });
    },
  );
}

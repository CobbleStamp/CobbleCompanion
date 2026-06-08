/**
 * Proactivity & vitality routes (Phase 4). The companion's two vitality wallets made
 * legible (architecture.md §4.8): GET the stamina/energy meter, and set the
 * proactivity dial. Refilling a wallet is the feeding economy's job (`POST /feed`,
 * growth.routes.ts) — there is no manual top-up. All owner-scoped.
 */

import { setProactivityDialSchema, type StaminaEnergyDto } from '@cobble/shared';
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

  async function budget(companionId: string): Promise<StaminaEnergyDto> {
    return buildBudget(quota, energy, companionId);
  }

  // The vitality meter: stamina (user-initiated) + energy (self-initiated) — both
  // per-companion (architecture.md §4.8).
  app.get(
    '/companions/:companionId/budget',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      return reply.send(await budget(companion.id));
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

import { feed } from '@cobble/core';
import { feedSchema, setProactivityDialSchema, type FeedResultDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import { buildBudget } from '../../routes/vitality.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, ConflictError, parseParams } from './helpers.js';

/**
 * Vitality, growth, and feeding methods (mirrors proactivity/usage/growth routes).
 * Companion-scoped methods act on the embodied companion; `food.*` is per-user.
 */
export function vitalityMethods(deps: AppDeps): WsMethods {
  const { identity, growth, quota, energy, food, embodiment, logger } = deps;
  return {
    'budget.get': async (ctx) => buildBudget(quota, energy, await companionOf(embodiment, ctx)),

    'usage.get': async (ctx) => ({
      usage: { balanceTokens: await quota.getBalance(await companionOf(embodiment, ctx)) },
    }),

    'growth.get': async (ctx) => growth.snapshot(await companionOf(embodiment, ctx)),

    'proactivity.set': async (ctx, params) => {
      const { dial } = parseParams(
        setProactivityDialSchema,
        params,
        'a valid dial (off|gentle|active) is required',
      );
      await identity.setProactivityDial(await companionOf(embodiment, ctx), dial);
      return { dial };
    },

    'food.get': async (ctx) => ({ food: await food.getPantry(ctx.userId) }),

    feed: async (ctx, params): Promise<FeedResultDto> => {
      const parsed = parseParams(
        feedSchema,
        params,
        'a valid food (ration|spark|treat) is required',
      );
      const companionId = await companionOf(embodiment, ctx);
      const result = await feed(
        { food, stamina: quota, energy, logger },
        { companionId, userId: ctx.userId, food: parsed.food },
      );
      if (!result.ok) {
        throw new ConflictError(result.reason ?? 'cannot feed');
      }
      return {
        budget: await buildBudget(quota, energy, companionId),
        food: await food.getPantry(ctx.userId),
      };
    },
  };
}

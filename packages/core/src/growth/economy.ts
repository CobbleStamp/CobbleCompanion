/**
 * The feeding economy (Phase 5, development-plan.md §3) — giving the companion a
 * "food" spends earned treats and tops up a vitality pool. A thin game layer over
 * the existing atomic top-ups: `ration` favours stamina (so you can keep talking),
 * `spark` favours energy (so it can go explore), `treat` feeds both a little. Treats
 * are the only gate — they're plentiful (a starting balance + growth milestones), so
 * feeding stays demonstrable while connecting growth to vitality.
 */

import { foodDef, type FoodType } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { CompanionEnergyStore } from '../quota/energy-store.js';
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import type { GrowthStore } from './growth-store.js';

export interface FeedDeps {
  readonly growth: GrowthStore;
  /** Stamina pool (per-user) — `ration`/`treat` feed it. */
  readonly quota: TokenQuotaStore;
  /** Energy pool (per-companion) — `spark`/`treat` feed it. */
  readonly energy: CompanionEnergyStore;
  /** Audits a top-up that fails *after* the treat was already debited. */
  readonly logger: Logger;
}

export interface FeedParams {
  readonly companionId: string;
  readonly ownerId: string;
  readonly food: FoodType;
}

/** Outcome of a feed: `ok` false (with a reason) when treats can't cover the food. */
export interface FeedResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Spend the food's treat cost, then top up the pools it favours. Treats are
 * debited first (atomic, balance-guarded), so a food is never granted for free; if
 * the companion can't afford it, the pools are untouched and `ok` is false.
 *
 * The spend and the two top-ups are not transactional across stores: once treats
 * are debited, a top-up that throws leaves the treat spent for an unfulfilled (or
 * partly fulfilled) food. There's no treat refund to compensate with, so the
 * fallback is auditability — we log the lost treat with full context, then rethrow
 * so the caller surfaces the failure rather than reporting a phantom success.
 */
export async function feed(deps: FeedDeps, params: FeedParams): Promise<FeedResult> {
  const def = foodDef(params.food);
  if (!def) {
    return { ok: false, reason: 'unknown food' };
  }
  const afforded = await deps.growth.spendTreats(params.companionId, def.treatCost);
  if (!afforded) {
    return { ok: false, reason: 'not enough treats' };
  }
  // From here treats are already gone: any throw means a debited-but-lost treat.
  let staminaToppedUp = false;
  try {
    if (def.staminaTokens > 0) {
      await deps.quota.topUp(params.ownerId, def.staminaTokens);
      staminaToppedUp = true;
    }
    if (def.energyTokens > 0) {
      await deps.energy.topUp(params.companionId, def.energyTokens);
    }
  } catch (error) {
    deps.logger.error('feed top-up failed after treats were debited; treat lost', {
      companionId: params.companionId,
      ownerId: params.ownerId,
      food: params.food,
      treatCost: def.treatCost,
      staminaTokens: def.staminaTokens,
      energyTokens: def.energyTokens,
      // Distinguishes a fully-lost treat from a partial grant (stamina in, energy out).
      staminaToppedUp,
      error,
    });
    throw error;
  }
  return { ok: true };
}

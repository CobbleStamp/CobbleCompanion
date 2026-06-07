/**
 * The feeding economy (development-plan.md §3) — feeding a companion a "food"
 * consumes one from the **user's** pantry and adds its tokens to the **companion's**
 * vitality wallet(s): `ration` favours stamina (so you can keep talking), `spark`
 * favours energy (so it can go explore), `treat` feeds both a little. Having the food
 * is the only gate — the pantry is seeded and not replenished in the PoC (no currency,
 * no buying — `companion-economy.md`).
 */

import { foodDef, type FoodType } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import type { FoodStore } from './food-store.js';

export interface FeedDeps {
  /** The user's food pantry — `consume` debits one food, count-guarded. */
  readonly food: FoodStore;
  /** Stamina wallet (per-companion) — `ration`/`treat` add to it. */
  readonly stamina: VitalityStore;
  /** Energy wallet (per-companion) — `spark`/`treat` add to it. */
  readonly energy: VitalityStore;
  /** Audits a wallet add that fails *after* the food was already consumed. */
  readonly logger: Logger;
}

export interface FeedParams {
  /** The companion fed — whose wallet(s) the food refills. */
  readonly companionId: string;
  /** The user feeding — whose pantry the food is consumed from. */
  readonly userId: string;
  readonly food: FoodType;
}

/** Outcome of a feed: `ok` false (with a reason) when the user has none of the food. */
export interface FeedResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Consume one of the food from the user's pantry, then add its grants to the
 * companion's wallet(s). The pantry is debited first (atomic, count-guarded), so a
 * food is never granted for free; if the user has none, the wallets are untouched and
 * `ok` is false.
 *
 * The consume and the two adds are not transactional across stores: once the food is
 * consumed, an add that throws leaves the food spent for an unfulfilled (or partly
 * fulfilled) feed. There's no refund to compensate with, so the fallback is
 * auditability — we log the lost food with full context, then rethrow so the caller
 * surfaces the failure rather than reporting a phantom success.
 */
export async function feed(deps: FeedDeps, params: FeedParams): Promise<FeedResult> {
  const def = foodDef(params.food);
  if (!def) {
    return { ok: false, reason: 'unknown food' };
  }
  const consumed = await deps.food.consume(params.userId, params.food);
  if (!consumed) {
    return { ok: false, reason: `out of ${params.food}` };
  }
  // From here the food is already gone: any throw means a consumed-but-lost food.
  let staminaAdded = false;
  try {
    if (def.staminaTokens > 0) {
      await deps.stamina.add(params.companionId, def.staminaTokens);
      staminaAdded = true;
    }
    if (def.energyTokens > 0) {
      await deps.energy.add(params.companionId, def.energyTokens);
    }
  } catch (error) {
    deps.logger.error('feed wallet add failed after the food was consumed; food lost', {
      companionId: params.companionId,
      userId: params.userId,
      food: params.food,
      staminaTokens: def.staminaTokens,
      energyTokens: def.energyTokens,
      // Distinguishes a fully-lost food from a partial grant (stamina in, energy out).
      staminaAdded,
      error,
    });
    throw error;
  }
  return { ok: true };
}

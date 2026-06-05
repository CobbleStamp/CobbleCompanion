/**
 * Companion energy store — the SELF-INITIATED pool that fuels the motivation
 * engine (architecture.md §4.8, companion-motivation.md §8). Mirrors the stamina
 * pool (`DrizzleTokenQuotaStore`) but keyed per COMPANION and with a manual
 * top-up: the effective cap is `(capOverride ?? default) + topUpTokens`, so the
 * user can feed energy to keep the companion initiating. Separate counters from
 * stamina mean autonomous work can never starve interaction — when energy is
 * exhausted the engine stops initiating while chat still runs on stamina.
 *
 * The window is fixed daily (resets 00:00 UTC); when it rolls, overage carries
 * forward as debt clamped to one cap (never a multi-day lockout), and the user's
 * `topUpTokens` grant persists across the roll. Concurrency mirrors the stamina
 * store: atomic SQL increments for spend/top-up, and a conditional window roll
 * guarded on the observed reset instant.
 */

import { type Database, companionEnergy } from '@cobble/db';
import { and, eq, sql } from 'drizzle-orm';

/** A companion's current energy standing, for the meter and the engine's gate. */
export interface EnergySnapshot {
  readonly usedTokens: number;
  /** Effective cap: `(capOverride ?? default) + topUpTokens`. */
  readonly capTokens: number;
  /** ISO instant when the current window resets (00:00 UTC). */
  readonly resetsAt: string;
}

export interface CompanionEnergyStore {
  /** Current standing, rolling the window first if it has expired. */
  getEnergy(companionId: string): Promise<EnergySnapshot>;
  /** Add spent tokens to the current window (no-op for non-positive amounts). */
  recordSpend(companionId: string, totalTokens: number): Promise<void>;
  /** True when the companion has met or exceeded its effective energy cap. */
  isExhausted(companionId: string): Promise<boolean>;
  /** Add to the user's manual energy grant, raising the effective cap (the feed control). */
  topUp(companionId: string, amount: number): Promise<void>;
}

export interface DrizzleCompanionEnergyStoreOptions {
  /** Base energy cap (tokens/window) for companions without a `cap_override`. */
  readonly defaultCapTokens: number;
  /** Injectable clock for deterministic window-roll tests. */
  readonly now?: () => Date;
}

/** Start of the next UTC day strictly after `now` — the window's reset instant. */
function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

export class DrizzleCompanionEnergyStore implements CompanionEnergyStore {
  private readonly defaultCap: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: DrizzleCompanionEnergyStoreOptions,
  ) {
    this.defaultCap = options.defaultCapTokens;
    this.now = options.now ?? ((): Date => new Date());
  }

  async getEnergy(companionId: string): Promise<EnergySnapshot> {
    const { used, cap, resetsAt } = await this.loadAndRoll(companionId);
    return { usedTokens: used, capTokens: cap, resetsAt: resetsAt.toISOString() };
  }

  async recordSpend(companionId: string, totalTokens: number): Promise<void> {
    if (totalTokens <= 0) {
      return;
    }
    // Roll first so the increment lands in the current window, then increment
    // atomically in SQL so a concurrent debit can't lose an update.
    await this.loadAndRoll(companionId);
    await this.db
      .update(companionEnergy)
      .set({
        usedTokens: sql`${companionEnergy.usedTokens} + ${totalTokens}`,
        updatedAt: this.now(),
      })
      .where(eq(companionEnergy.companionId, companionId));
  }

  async isExhausted(companionId: string): Promise<boolean> {
    const { used, cap } = await this.loadAndRoll(companionId);
    return used >= cap;
  }

  async topUp(companionId: string, amount: number): Promise<void> {
    if (amount <= 0) {
      return;
    }
    await this.loadAndRoll(companionId);
    await this.db
      .update(companionEnergy)
      .set({
        topUpTokens: sql`${companionEnergy.topUpTokens} + ${amount}`,
        updatedAt: this.now(),
      })
      .where(eq(companionEnergy.companionId, companionId));
  }

  /**
   * Load the companion's window, creating it on first use and rolling it
   * (carrying clamped debt, preserving the top-up grant) when it has expired.
   * Returns the live used/cap/reset for the current window.
   */
  private async loadAndRoll(
    companionId: string,
  ): Promise<{ used: number; cap: number; resetsAt: Date }> {
    const now = this.now();
    const [row] = await this.db
      .select()
      .from(companionEnergy)
      .where(eq(companionEnergy.companionId, companionId))
      .limit(1);

    if (!row) {
      const resetsAt = nextUtcMidnight(now);
      await this.db
        .insert(companionEnergy)
        .values({ companionId, windowResetAt: resetsAt, usedTokens: 0 })
        .onConflictDoNothing();
      return { used: 0, cap: this.defaultCap, resetsAt };
    }

    const cap = (row.capOverride ?? this.defaultCap) + row.topUpTokens;
    if (now >= row.windowResetAt) {
      // Carry overage as debt, clamped to one cap; the top-up grant persists.
      const debt = Math.min(cap, Math.max(0, row.usedTokens - cap));
      const resetsAt = nextUtcMidnight(now);
      const rolled = await this.db
        .update(companionEnergy)
        .set({ usedTokens: debt, windowResetAt: resetsAt, updatedAt: now })
        .where(
          and(
            eq(companionEnergy.companionId, companionId),
            eq(companionEnergy.windowResetAt, row.windowResetAt),
          ),
        )
        .returning();
      if (rolled.length > 0) {
        return { used: debt, cap, resetsAt };
      }
      // A concurrent first-of-window call already rolled; re-read and proceed.
      const [fresh] = await this.db
        .select()
        .from(companionEnergy)
        .where(eq(companionEnergy.companionId, companionId))
        .limit(1);
      if (fresh) {
        const freshCap = (fresh.capOverride ?? this.defaultCap) + fresh.topUpTokens;
        return { used: fresh.usedTokens, cap: freshCap, resetsAt: fresh.windowResetAt };
      }
      return { used: debt, cap, resetsAt };
    }

    return { used: row.usedTokens, cap, resetsAt: row.windowResetAt };
  }
}

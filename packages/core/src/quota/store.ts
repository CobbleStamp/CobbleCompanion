/**
 * Token quota store — the per-user daily cap's state (architecture.md token
 * budget). One row per user in `user_token_usage`: a running token counter for
 * the current window plus the instant it resets. The window is **fixed daily**
 * (resets at 00:00 UTC); when it rolls, overage carries forward as **debt
 * clamped to one cap**, so the worst case is "tomorrow starts at zero", never a
 * multi-day lockout. The effective cap is the per-account override or, absent
 * one, the configured default.
 *
 * Concurrency: the accrual increment is applied atomically in SQL
 * (`used = used + n`), so concurrent debits for the same user (e.g. a chat turn
 * and a memory-search) can't lose an update. The window roll uses a conditional
 * update guarded on the observed `windowResetAt`; if a concurrent first-of-day
 * call already won the roll, this one re-reads and proceeds. Multi-replica
 * serialization beyond this is a later add.
 */

import { type Database, userTokenUsage } from '@cobble/db';
import { and, eq, sql } from 'drizzle-orm';

/** A user's current budget standing, for the UI and the cap checks. */
export interface UsageSnapshot {
  readonly usedTokens: number;
  readonly capTokens: number;
  /** ISO instant when the current window resets (00:00 UTC). */
  readonly resetsAt: string;
}

export interface TokenQuotaStore {
  /** Current standing, rolling the window first if it has expired. */
  getUsage(userId: string): Promise<UsageSnapshot>;
  /** Add spent tokens to the current window (no-op for non-positive amounts). */
  recordUsage(userId: string, totalTokens: number): Promise<void>;
  /** True when the user has met or exceeded their effective cap. */
  isOverCap(userId: string): Promise<boolean>;
}

export interface DrizzleTokenQuotaStoreOptions {
  /** Cap (tokens/day) for accounts without a `cap_override`. */
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

export class DrizzleTokenQuotaStore implements TokenQuotaStore {
  private readonly defaultCap: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: DrizzleTokenQuotaStoreOptions,
  ) {
    this.defaultCap = options.defaultCapTokens;
    this.now = options.now ?? ((): Date => new Date());
  }

  async getUsage(userId: string): Promise<UsageSnapshot> {
    const { used, cap, resetsAt } = await this.loadAndRoll(userId);
    return { usedTokens: used, capTokens: cap, resetsAt: resetsAt.toISOString() };
  }

  async recordUsage(userId: string, totalTokens: number): Promise<void> {
    if (totalTokens <= 0) {
      return;
    }
    // Roll the window first so the increment lands in the current window, then
    // apply the increment atomically in SQL — a concurrent debit for the same
    // user reads-and-writes against the live row, so no update is lost.
    await this.loadAndRoll(userId);
    await this.db
      .update(userTokenUsage)
      .set({
        usedTokens: sql`${userTokenUsage.usedTokens} + ${totalTokens}`,
        updatedAt: this.now(),
      })
      .where(eq(userTokenUsage.userId, userId));
  }

  async isOverCap(userId: string): Promise<boolean> {
    const { used, cap } = await this.loadAndRoll(userId);
    return used >= cap;
  }

  /**
   * Load the user's window, creating it on first use and rolling it (carrying
   * clamped debt) when it has expired. Returns the live used/cap/reset for the
   * current window; persists the roll/creation so reads are idempotent.
   */
  private async loadAndRoll(
    userId: string,
  ): Promise<{ used: number; cap: number; resetsAt: Date }> {
    const now = this.now();
    const [row] = await this.db
      .select()
      .from(userTokenUsage)
      .where(eq(userTokenUsage.userId, userId))
      .limit(1);

    if (!row) {
      const resetsAt = nextUtcMidnight(now);
      await this.db
        .insert(userTokenUsage)
        .values({ userId, windowResetAt: resetsAt, usedTokens: 0 })
        .onConflictDoNothing();
      return { used: 0, cap: this.defaultCap, resetsAt };
    }

    const cap = row.capOverride ?? this.defaultCap;
    if (now >= row.windowResetAt) {
      // Carry overage as debt, clamped to one cap so a runaway call never locks
      // the account out beyond the next window.
      const debt = Math.min(cap, Math.max(0, row.usedTokens - cap));
      const resetsAt = nextUtcMidnight(now);
      // Guard the roll on the observed reset instant: only the request that sees
      // the still-expired window writes the new one. A concurrent first-of-day
      // call that already rolled changes `windowResetAt`, so this update matches
      // 0 rows — in which case we re-read the freshly-rolled row and proceed.
      const rolled = await this.db
        .update(userTokenUsage)
        .set({ usedTokens: debt, windowResetAt: resetsAt, updatedAt: now })
        .where(
          and(
            eq(userTokenUsage.userId, userId),
            eq(userTokenUsage.windowResetAt, row.windowResetAt),
          ),
        )
        .returning();
      if (rolled.length > 0) {
        return { used: debt, cap, resetsAt };
      }
      const [fresh] = await this.db
        .select()
        .from(userTokenUsage)
        .where(eq(userTokenUsage.userId, userId))
        .limit(1);
      if (fresh) {
        const freshCap = fresh.capOverride ?? this.defaultCap;
        return {
          used: fresh.usedTokens,
          cap: freshCap,
          resetsAt: fresh.windowResetAt,
        };
      }
      // Extremely unlikely (row vanished); fall back to our computed roll.
      return { used: debt, cap, resetsAt };
    }

    return { used: row.usedTokens, cap, resetsAt: row.windowResetAt };
  }
}

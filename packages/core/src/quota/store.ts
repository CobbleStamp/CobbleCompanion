/**
 * Token quota store — the per-user daily cap's state (architecture.md token
 * budget). One row per user in `user_token_usage`: a running token counter for
 * the current window plus the instant it resets. The window is **fixed daily**
 * (resets at 00:00 UTC); when it rolls, overage carries forward as **debt
 * clamped to one cap**, so the worst case is "tomorrow starts at zero", never a
 * multi-day lockout. The effective cap is the per-account override or, absent
 * one, the configured default.
 *
 * PoC scope: read-modify-write without an explicit transaction. Same-user
 * concurrency is effectively absent (chat is turn-based, ingestion serial), so a
 * race would at worst miscount slightly; multi-replica atomicity is a later add.
 */

import { type Database, userTokenUsage } from '@cobble/db';
import { eq } from 'drizzle-orm';

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
    const { used } = await this.loadAndRoll(userId);
    await this.db
      .update(userTokenUsage)
      .set({ usedTokens: used + totalTokens, updatedAt: this.now() })
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
      await this.db
        .update(userTokenUsage)
        .set({ usedTokens: debt, windowResetAt: resetsAt, updatedAt: now })
        .where(eq(userTokenUsage.userId, userId));
      return { used: debt, cap, resetsAt };
    }

    return { used: row.usedTokens, cap, resetsAt: row.windowResetAt };
  }
}

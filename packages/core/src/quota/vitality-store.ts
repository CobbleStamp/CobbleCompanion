/**
 * Vitality wallet store (architecture.md §4.8) — a per-companion token balance that
 * spends **down** as the companion works and refills **up** only by feeding. Backs
 * BOTH stamina and energy: they are two columns on the `companions` row (inline, 1:1
 * with the companion — no separate table), so one implementation serves both, picked
 * by the `kind` discriminator at construction.
 *
 * No cap, no daily window, no auto-refill. The balance is **seeded at companion
 * creation** (`DrizzleIdentityStore`, from `STARTING_VITALITY_TOKENS`), **decremented**
 * on spend (atomic `GREATEST(0, balance - n)`, so a single overshooting turn empties
 * the wallet but never drives it negative — no debt under the wallet model), and
 * **incremented** on feed. Concurrency: spend and feed are atomic SQL updates, so
 * concurrent debits/feeds for the same companion can't lose an update.
 *
 * `VitalityStore` is also the generic metering contract the ingestion pipeline bills
 * through — the run spends either the companion's stamina (default) or its energy
 * (the motivation engine's per-run override), both the same interface.
 */

import { type Database, companions } from '@cobble/db';
import { eq, sql } from 'drizzle-orm';

/** Which half of a companion's vitality a store meters. */
export type VitalityKind = 'stamina' | 'energy';

export interface VitalityStore {
  /** Current balance; 0 if the companion has no row yet. */
  getBalance(companionId: string): Promise<number>;
  /** Subtract spent tokens, floored at 0 (no-op for non-positive amounts). */
  spend(companionId: string, tokens: number): Promise<void>;
  /** Add tokens (feeding); no-op for non-positive amounts. */
  add(companionId: string, tokens: number): Promise<void>;
  /** True when the wallet is empty (balance ≤ 0) — the gate for spending. */
  isEmpty(companionId: string): Promise<boolean>;
}

export class DrizzleVitalityStore implements VitalityStore {
  constructor(
    private readonly db: Database,
    private readonly kind: VitalityKind,
  ) {}

  /** The companions column this store meters. */
  private get column() {
    return this.kind === 'stamina'
      ? companions.staminaBalanceTokens
      : companions.energyBalanceTokens;
  }

  async getBalance(companionId: string): Promise<number> {
    const [row] = await this.db
      .select({ balance: this.column })
      .from(companions)
      .where(eq(companions.id, companionId))
      .limit(1);
    return row?.balance ?? 0;
  }

  async isEmpty(companionId: string): Promise<boolean> {
    return (await this.getBalance(companionId)) <= 0;
  }

  async spend(companionId: string, tokens: number): Promise<void> {
    if (tokens <= 0) {
      return;
    }
    const column = this.column;
    await this.db
      .update(companions)
      .set(
        this.kind === 'stamina'
          ? { staminaBalanceTokens: sql`GREATEST(0, ${column} - ${tokens})` }
          : { energyBalanceTokens: sql`GREATEST(0, ${column} - ${tokens})` },
      )
      .where(eq(companions.id, companionId));
  }

  async add(companionId: string, tokens: number): Promise<void> {
    if (tokens <= 0) {
      return;
    }
    const column = this.column;
    await this.db
      .update(companions)
      .set(
        this.kind === 'stamina'
          ? { staminaBalanceTokens: sql`${column} + ${tokens}` }
          : { energyBalanceTokens: sql`${column} + ${tokens}` },
      )
      .where(eq(companions.id, companionId));
  }
}

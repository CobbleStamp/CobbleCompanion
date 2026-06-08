/**
 * Vitality wallet store (architecture.md §4.8) — a per-companion token balance that
 * spends **down** as the companion works and refills **up** only by feeding. Backs
 * BOTH stamina and energy: they are two columns on the `companions` row (inline, 1:1
 * with the companion — no separate table), so one implementation serves both, picked
 * by the `kind` discriminator at construction.
 *
 * No economic cap, no daily window, no auto-refill (feeding is bounded only by
 * {@link MAX_SAFE_BALANCE}, a marshaling safety net far above any real balance). The balance is **seeded at companion
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

/**
 * Hard ceiling on a wallet balance, enforced when feeding (`add`). The columns are
 * `bigint` but marshal back through drizzle's `mode: 'number'`, so any value above
 * `Number.MAX_SAFE_INTEGER` (2^53-1) would lose precision on read. Capping the
 * increment here keeps the column inside the exactly-representable range, so every
 * `getBalance` read is lossless. Not an economic cap — it sits ~9 quadrillion tokens
 * above the real 1M-seed / 200k-grant scale and is unreachable in practice.
 */
const MAX_SAFE_BALANCE = Number.MAX_SAFE_INTEGER;

/**
 * Thrown by `spend`/`add` when the companionId matches no row — a debit or feed
 * against a missing (or deleted) companion would otherwise touch 0 rows and report
 * a phantom success. Callers map it to 404 (API) or log-and-rethrow (workers).
 */
export class CompanionNotFoundError extends Error {
  constructor(public readonly companionId: string) {
    super('companion not found');
    this.name = 'CompanionNotFoundError';
  }
}

export interface VitalityStore {
  /** Current balance; 0 if the companion has no row yet. */
  getBalance(companionId: string): Promise<number>;
  /**
   * Subtract spent tokens, floored at 0 (no-op for non-positive amounts).
   * Throws {@link CompanionNotFoundError} if the companion does not exist.
   */
  spend(companionId: string, tokens: number): Promise<void>;
  /**
   * Add tokens (feeding); no-op for non-positive amounts. The result is capped at
   * {@link MAX_SAFE_BALANCE} so the `bigint` column never exceeds the range that
   * marshals back losslessly. Throws {@link CompanionNotFoundError} if the companion
   * does not exist.
   */
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
    // Guard the SQL boundary: only a finite, positive amount may reach the atomic
    // update. A negative amount would otherwise turn `balance - n` into a credit
    // (a spend that ADDS tokens), and `NaN`/`Infinity` slip past a bare `<= 0`
    // check (`NaN <= 0` is false) and would poison the bigint column.
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    const column = this.column;
    const updated = await this.db
      .update(companions)
      .set(
        this.kind === 'stamina'
          ? { staminaBalanceTokens: sql`GREATEST(0, ${column} - ${tokens})` }
          : { energyBalanceTokens: sql`GREATEST(0, ${column} - ${tokens})` },
      )
      .where(eq(companions.id, companionId))
      .returning({ id: companions.id });
    if (updated.length === 0) {
      throw new CompanionNotFoundError(companionId);
    }
  }

  async add(companionId: string, tokens: number): Promise<void> {
    // Same finite-and-positive guard as `spend`: a negative feed must not silently
    // drain the wallet, and non-finite amounts must never reach the bigint column.
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    const column = this.column;
    const updated = await this.db
      .update(companions)
      .set(
        this.kind === 'stamina'
          ? { staminaBalanceTokens: sql`LEAST(${MAX_SAFE_BALANCE}, ${column} + ${tokens})` }
          : { energyBalanceTokens: sql`LEAST(${MAX_SAFE_BALANCE}, ${column} + ${tokens})` },
      )
      .where(eq(companions.id, companionId))
      .returning({ id: companions.id });
    if (updated.length === 0) {
      throw new CompanionNotFoundError(companionId);
    }
  }
}

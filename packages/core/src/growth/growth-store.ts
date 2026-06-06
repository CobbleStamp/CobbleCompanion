/**
 * Growth snapshot store (Phase 5) — persists the *acknowledged high-water mark*
 * (the last levels/abilities/stage already celebrated) and the earned `treats`
 * balance. The mark exists only to make the progression pass's side effects
 * idempotent: `advance` is a compare-and-set on the monotonic levels/stage/unlock
 * count, so two concurrent recomputes (a background trigger and a `GET /growth`)
 * can never double-award treats or double-fire a growth note. Mirrors the
 * energy-store's atomic-increment + conditional-update concurrency model.
 */

import { type Database, companionGrowth } from '@cobble/db';
import type { CapabilityKey } from '@cobble/shared';
import { and, eq, sql } from 'drizzle-orm';

/** The persisted high-water mark (highest band already reflected on) + treats balance. */
export interface GrowthSnapshot {
  readonly knowledgeBand: number;
  readonly bondBand: number;
  readonly initiativeBand: number;
  readonly observedCapabilities: readonly CapabilityKey[];
  readonly treats: number;
}

/** The derived target a recompute wants to advance the mark to. */
export interface GrowthTarget {
  readonly knowledgeBand: number;
  readonly bondBand: number;
  readonly initiativeBand: number;
  readonly observedCapabilities: readonly CapabilityKey[];
}

export interface GrowthStore {
  /** Load the mark, lazily creating the row (seeded with the initial treats) on first use. */
  getSnapshot(companionId: string): Promise<GrowthSnapshot>;
  /**
   * Compare-and-set the mark from `from` to `target`, adding `treatsEarned`.
   * Returns true iff this caller won (the row still matched `from`); false means a
   * concurrent recompute already advanced it, so this caller awards nothing.
   */
  advance(
    companionId: string,
    from: GrowthSnapshot,
    target: GrowthTarget,
    treatsEarned: number,
  ): Promise<boolean>;
  /**
   * Atomically spend treats iff the balance covers `amount`. Returns true on
   * success, false if the companion can't afford it (the balance is untouched).
   */
  spendTreats(companionId: string, amount: number): Promise<boolean>;
}

export interface DrizzleGrowthStoreOptions {
  /** Treats a brand-new companion starts with, so feeding works on day one. */
  readonly initialTreats: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export class DrizzleGrowthStore implements GrowthStore {
  private readonly initialTreats: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: DrizzleGrowthStoreOptions,
  ) {
    this.initialTreats = options.initialTreats;
    this.now = options.now ?? ((): Date => new Date());
  }

  async getSnapshot(companionId: string): Promise<GrowthSnapshot> {
    const existing = await this.read(companionId);
    if (existing) {
      return existing;
    }
    // First touch: seed the row with the starting treats (idempotent on conflict).
    await this.db
      .insert(companionGrowth)
      .values({ companionId, treats: this.initialTreats })
      .onConflictDoNothing();
    return (await this.read(companionId)) ?? this.empty();
  }

  async advance(
    companionId: string,
    from: GrowthSnapshot,
    target: GrowthTarget,
    treatsEarned: number,
  ): Promise<boolean> {
    const rolled = await this.db
      .update(companionGrowth)
      .set({
        knowledgeBand: target.knowledgeBand,
        bondBand: target.bondBand,
        initiativeBand: target.initiativeBand,
        observedCapabilities: target.observedCapabilities,
        treats: sql`${companionGrowth.treats} + ${treatsEarned}`,
        updatedAt: this.now(),
      })
      .where(
        and(
          eq(companionGrowth.companionId, companionId),
          // Guard on the monotonic mark we read — a concurrent advance changes one
          // of these, so the loser's WHERE misses and it awards nothing.
          eq(companionGrowth.knowledgeBand, from.knowledgeBand),
          eq(companionGrowth.bondBand, from.bondBand),
          eq(companionGrowth.initiativeBand, from.initiativeBand),
          sql`jsonb_array_length(${companionGrowth.observedCapabilities}) = ${from.observedCapabilities.length}`,
        ),
      )
      .returning();
    return rolled.length > 0;
  }

  async spendTreats(companionId: string, amount: number): Promise<boolean> {
    if (amount <= 0) {
      return true;
    }
    // Ensure the row exists (and is seeded) before the conditional debit.
    await this.getSnapshot(companionId);
    const rolled = await this.db
      .update(companionGrowth)
      .set({ treats: sql`${companionGrowth.treats} - ${amount}`, updatedAt: this.now() })
      .where(
        and(
          eq(companionGrowth.companionId, companionId),
          // Only debit if the balance covers it — never let treats go negative.
          sql`${companionGrowth.treats} >= ${amount}`,
        ),
      )
      .returning();
    return rolled.length > 0;
  }

  private async read(companionId: string): Promise<GrowthSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(companionGrowth)
      .where(eq(companionGrowth.companionId, companionId))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      knowledgeBand: row.knowledgeBand,
      bondBand: row.bondBand,
      initiativeBand: row.initiativeBand,
      observedCapabilities: (row.observedCapabilities ?? []) as readonly CapabilityKey[],
      treats: row.treats,
    };
  }

  private empty(): GrowthSnapshot {
    return {
      knowledgeBand: 0,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
      treats: this.initialTreats,
    };
  }
}

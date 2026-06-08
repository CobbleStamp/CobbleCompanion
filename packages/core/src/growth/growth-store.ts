/**
 * Growth snapshot store (Phase 5) — persists the *acknowledged high-water mark*
 * (the highest band index per axis + the capabilities already observed). The mark
 * exists only to make the progression pass's side effect idempotent: `advance` is a
 * compare-and-set on the monotonic band indices + observed-capability count, so two
 * concurrent post-turn recomputes can never double-fire a growth reflection. The
 * mirror is fully decoupled from feeding — it stores nothing spendable.
 */

import { type Database, companionGrowth } from '@cobble/db';
import type { CapabilityKey } from '@cobble/shared';
import { and, eq, sql } from 'drizzle-orm';

/** The persisted high-water mark — the highest band already reflected on. */
export interface GrowthSnapshot {
  readonly knowledgeBand: number;
  readonly bondBand: number;
  readonly initiativeBand: number;
  readonly observedCapabilities: readonly CapabilityKey[];
}

/** The derived target a recompute wants to advance the mark to. */
export interface GrowthTarget {
  readonly knowledgeBand: number;
  readonly bondBand: number;
  readonly initiativeBand: number;
  readonly observedCapabilities: readonly CapabilityKey[];
}

export interface GrowthStore {
  /** Load the mark, lazily creating the row on first use. */
  getSnapshot(companionId: string): Promise<GrowthSnapshot>;
  /**
   * Compare-and-set the mark from `from` to `target`. Returns true iff this caller
   * won (the row still matched `from`); false means a concurrent recompute already
   * advanced it, so this caller posts no reflection.
   */
  advance(companionId: string, from: GrowthSnapshot, target: GrowthTarget): Promise<boolean>;
}

export interface DrizzleGrowthStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export class DrizzleGrowthStore implements GrowthStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: DrizzleGrowthStoreOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async getSnapshot(companionId: string): Promise<GrowthSnapshot> {
    const existing = await this.read(companionId);
    if (existing) {
      return existing;
    }
    // First touch: create the row at the empty mark (idempotent on conflict).
    await this.db.insert(companionGrowth).values({ companionId }).onConflictDoNothing();
    return (await this.read(companionId)) ?? this.empty();
  }

  async advance(companionId: string, from: GrowthSnapshot, target: GrowthTarget): Promise<boolean> {
    const rolled = await this.db
      .update(companionGrowth)
      .set({
        knowledgeBand: target.knowledgeBand,
        bondBand: target.bondBand,
        initiativeBand: target.initiativeBand,
        observedCapabilities: target.observedCapabilities,
        updatedAt: this.now(),
      })
      .where(
        and(
          eq(companionGrowth.companionId, companionId),
          // Guard on the monotonic mark we read — a concurrent advance changes one
          // of these, so the loser's WHERE misses and it posts nothing.
          eq(companionGrowth.knowledgeBand, from.knowledgeBand),
          eq(companionGrowth.bondBand, from.bondBand),
          eq(companionGrowth.initiativeBand, from.initiativeBand),
          sql`jsonb_array_length(${companionGrowth.observedCapabilities}) = ${from.observedCapabilities.length}`,
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
    };
  }

  private empty(): GrowthSnapshot {
    return {
      knowledgeBand: 0,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
    };
  }
}

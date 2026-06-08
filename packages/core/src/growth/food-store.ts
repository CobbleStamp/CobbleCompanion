/**
 * Food pantry store (companion-economy.md) — the per-user supply the feeding economy
 * spends. One row per user holding integer counts of each food type, seeded with
 * `initialFood` on first use and **not** replenished in the PoC (no currency, no
 * buying — a developer raises a count directly when a user runs out).
 *
 * Per USER, not per companion: a user spends the same pantry feeding any of their
 * companions (the food is the user's resource; the wallets it refills are the
 * companion's — `architecture.md` §2 invariant #5).
 *
 * `consume` is an **atomic, count-guarded** decrement: the `UPDATE … WHERE count > 0`
 * only succeeds when there is one to spend, so two racing feeds can't drive a count
 * negative and the caller learns unambiguously whether it got one.
 */

import { type Database, userFood } from '@cobble/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FoodType } from '@cobble/shared';

/** A user's pantry — counts of each food type they hold. */
export interface FoodInventory {
  readonly ration: number;
  readonly spark: number;
  readonly treat: number;
}

export interface FoodStore {
  /** The user's current pantry, creating it (seeded) on first use. */
  getPantry(userId: string): Promise<FoodInventory>;
  /** Consume one of `food`; returns false (a no-op) when the user has none left. */
  consume(userId: string, food: FoodType): Promise<boolean>;
}

export interface DrizzleFoodStoreOptions {
  /** Count of each food type a new user's pantry is seeded with. */
  readonly initialFood: number;
}

export class DrizzleFoodStore implements FoodStore {
  constructor(
    private readonly db: Database,
    private readonly options: DrizzleFoodStoreOptions,
  ) {}

  async getPantry(userId: string): Promise<FoodInventory> {
    return this.load(userId);
  }

  async consume(userId: string, food: FoodType): Promise<boolean> {
    await this.load(userId); // ensure the pantry exists (seeded)
    // Atomic guarded decrement — only the call that finds a positive count wins,
    // so concurrent feeds can't overspend or drive the count negative.
    const decrement = {
      ration: { ration: sql`${userFood.ration} - 1` },
      spark: { spark: sql`${userFood.spark} - 1` },
      treat: { treat: sql`${userFood.treat} - 1` },
    }[food];
    const guard = {
      ration: gt(userFood.ration, 0),
      spark: gt(userFood.spark, 0),
      treat: gt(userFood.treat, 0),
    }[food];
    const updated = await this.db
      .update(userFood)
      .set({ ...decrement, updatedAt: new Date() })
      .where(and(eq(userFood.userId, userId), guard))
      .returning();
    return updated.length > 0;
  }

  /** Read the pantry, lazily creating it seeded with `initialFood` of each food. */
  private async load(userId: string): Promise<FoodInventory> {
    const existing = await this.read(userId);
    if (existing) {
      return existing;
    }
    const n = this.options.initialFood;
    await this.db
      .insert(userFood)
      .values({ userId, ration: n, spark: n, treat: n })
      .onConflictDoNothing();
    // Re-read rather than trusting the seed: a concurrent feed may have won the
    // insert (and already decremented), so `onConflictDoNothing` left us out —
    // return the row that's actually stored, not the phantom seed.
    return (await this.read(userId)) ?? { ration: n, spark: n, treat: n };
  }

  private async read(userId: string): Promise<FoodInventory | null> {
    const [row] = await this.db.select().from(userFood).where(eq(userFood.userId, userId)).limit(1);
    return row ? { ration: row.ration, spark: row.spark, treat: row.treat } : null;
  }
}

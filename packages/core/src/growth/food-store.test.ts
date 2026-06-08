/**
 * Food pantry store — a per-USER supply seeded with `initialFood` of each type on
 * first use; `consume` is an atomic, count-guarded decrement that returns false when
 * the user has none of that food. One user's pantry is independent of another's.
 * Exercised over a real PGlite (fakes-over-mocks).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleFoodStore } from './food-store.js';

const INITIAL = 3;

describe('DrizzleFoodStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let userId: string;
  let store: DrizzleFoodStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    store = new DrizzleFoodStore(db, { initialFood: INITIAL });
  });
  afterEach(async () => {
    await close();
  });

  it('seeds the pantry with initialFood of each type on first use', async () => {
    expect(await store.getPantry(userId)).toEqual({
      ration: INITIAL,
      spark: INITIAL,
      treat: INITIAL,
    });
  });

  it('consume decrements the food and returns true while stock remains', async () => {
    expect(await store.consume(userId, 'ration')).toBe(true);
    const pantry = await store.getPantry(userId);
    expect(pantry.ration).toBe(INITIAL - 1);
    // The other foods are untouched.
    expect(pantry.spark).toBe(INITIAL);
    expect(pantry.treat).toBe(INITIAL);
  });

  it('consume at 0 returns false and leaves the count at 0 (no negative drift)', async () => {
    for (let i = 0; i < INITIAL; i += 1) {
      expect(await store.consume(userId, 'spark')).toBe(true);
    }
    expect((await store.getPantry(userId)).spark).toBe(0);
    // Out of sparks — the guarded decrement is a no-op returning false.
    expect(await store.consume(userId, 'spark')).toBe(false);
    expect((await store.getPantry(userId)).spark).toBe(0);
  });

  it("one user's pantry is independent of another's", async () => {
    const other = await identity.ensureUserByEmail('other@example.com');
    await store.consume(userId, 'treat');
    expect((await store.getPantry(userId)).treat).toBe(INITIAL - 1);
    // The other user's pantry is seeded fresh and untouched.
    expect((await store.getPantry(other.id)).treat).toBe(INITIAL);
  });

  it('concurrent consumes never overspend — exactly `initialFood` of them win', async () => {
    // Fire twice as many consumes as there is stock, all at once. The guarded
    // `UPDATE … WHERE count > 0` serialises at the row, so exactly INITIAL of them
    // return true and the rest return false — the count can't drive negative.
    const results = await Promise.all(
      Array.from({ length: INITIAL * 2 }, () => store.consume(userId, 'ration')),
    );
    expect(results.filter((won) => won).length).toBe(INITIAL);
    expect((await store.getPantry(userId)).ration).toBe(0);
  });

  it('two racing consumes at the last unit yield exactly one winner', async () => {
    // Drain to a single ration, then race two consumes for it.
    await store.consume(userId, 'ration');
    await store.consume(userId, 'ration');
    expect((await store.getPantry(userId)).ration).toBe(1);
    const [a, b] = await Promise.all([
      store.consume(userId, 'ration'),
      store.consume(userId, 'ration'),
    ]);
    expect([a, b].filter((won) => won).length).toBe(1);
    expect((await store.getPantry(userId)).ration).toBe(0);
  });
});

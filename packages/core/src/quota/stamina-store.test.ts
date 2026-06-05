/**
 * Stamina quota store tests against the real PGlite database: accrual, the
 * over-cap predicate, fixed-daily window roll with clamped debt, the per-account
 * cap override, and the manual top-up grant (atomic, concurrency-safe, persists
 * across rolls, and tracks the configured default).
 */

import { type Database, userTokenUsage } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleTokenQuotaStore } from './stamina-store.js';

const DEFAULT_CAP = 1000;

describe('DrizzleTokenQuotaStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;
  // Mutable clock so tests can advance time across the daily boundary.
  let clock: Date;

  function store(): DrizzleTokenQuotaStore {
    return new DrizzleTokenQuotaStore(db, {
      defaultCapTokens: DEFAULT_CAP,
      now: () => clock,
    });
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const user = await new DrizzleIdentityStore(db).ensureUserByEmail('owner@example.com');
    userId = user.id;
    clock = new Date('2026-06-03T10:00:00.000Z');
  });

  afterEach(async () => {
    await close();
  });

  it('starts empty and reports the next UTC midnight as the reset', async () => {
    const usage = await store().getUsage(userId);
    expect(usage.usedTokens).toBe(0);
    expect(usage.capTokens).toBe(DEFAULT_CAP);
    expect(usage.resetsAt).toBe('2026-06-04T00:00:00.000Z');
  });

  it('accrues recorded usage and flips over-cap at the ceiling', async () => {
    const quota = store();
    await quota.recordUsage(userId, 400);
    await quota.recordUsage(userId, 300);
    expect((await quota.getUsage(userId)).usedTokens).toBe(700);
    expect(await quota.isOverCap(userId)).toBe(false);

    await quota.recordUsage(userId, 300); // → 1000, meets the cap
    expect(await quota.isOverCap(userId)).toBe(true);
  });

  it('ignores non-positive amounts', async () => {
    const quota = store();
    await quota.recordUsage(userId, 0);
    await quota.recordUsage(userId, -50);
    expect((await quota.getUsage(userId)).usedTokens).toBe(0);
  });

  it('rolls the window at the daily boundary, carrying clamped overage as debt', async () => {
    const quota = store();
    await quota.recordUsage(userId, 1300); // 300 over the 1000 cap

    // Cross midnight UTC into the next day.
    clock = new Date('2026-06-04T00:00:01.000Z');
    const usage = await quota.getUsage(userId);
    expect(usage.usedTokens).toBe(300); // debt carried
    expect(usage.resetsAt).toBe('2026-06-05T00:00:00.000Z');
    expect(await quota.isOverCap(userId)).toBe(false);
  });

  it('clamps carried debt to at most one cap (no multi-day lockout)', async () => {
    const quota = store();
    await quota.recordUsage(userId, 5000); // 4000 over — would be 4 days of debt

    clock = new Date('2026-06-04T00:00:01.000Z');
    expect((await quota.getUsage(userId)).usedTokens).toBe(DEFAULT_CAP); // clamped to one cap
  });

  it('stays under cap at cap-1 and flips over once cap is exceeded', async () => {
    const quota = store();
    await quota.recordUsage(userId, DEFAULT_CAP - 1); // 999, one below the cap
    expect((await quota.getUsage(userId)).usedTokens).toBe(DEFAULT_CAP - 1);
    expect(await quota.isOverCap(userId)).toBe(false);

    await quota.recordUsage(userId, 2); // → 1001, over the cap
    expect(await quota.isOverCap(userId)).toBe(true);
  });

  it('rolls the window with a per-account cap override applied to debt', async () => {
    const quota = store();
    await quota.recordUsage(userId, 100); // creates the row
    await db
      .update(userTokenUsage)
      .set({ capOverride: 5000 })
      .where(eq(userTokenUsage.userId, userId));
    await quota.recordUsage(userId, 5900); // 6000 total, 1000 over the override

    // Cross midnight: debt clamps to the override cap, not the default.
    clock = new Date('2026-06-04T00:00:01.000Z');
    const usage = await quota.getUsage(userId);
    expect(usage.capTokens).toBe(5000);
    expect(usage.usedTokens).toBe(1000); // carried debt under the override cap
    expect(usage.resetsAt).toBe('2026-06-05T00:00:00.000Z');
    expect(await quota.isOverCap(userId)).toBe(false);
  });

  it('does not lose an update when two recordUsage calls interleave', async () => {
    const quota = store();
    await quota.recordUsage(userId, 1); // create the row up front
    await Promise.all([quota.recordUsage(userId, 400), quota.recordUsage(userId, 300)]);
    // Atomic SQL increment: both debits land regardless of interleaving.
    expect((await quota.getUsage(userId)).usedTokens).toBe(701);
  });

  it('re-reads instead of double-rolling when two callers race across midnight', async () => {
    // Spend over the cap, then advance past the reset so the next calls must roll.
    // Two interleaved callers race: one wins the guarded roll (changing
    // windowResetAt), the other's conditional update matches 0 rows and takes the
    // re-read path. The window must roll exactly once — debt carried once, clamped,
    // and the racing caller's spend not lost.
    const quota = store();
    await quota.recordUsage(userId, 1300); // 300 over the 1000 cap

    clock = new Date('2026-06-04T00:00:01.000Z'); // past the reset instant
    await Promise.all([quota.getUsage(userId), quota.recordUsage(userId, 50)]);

    const usage = await quota.getUsage(userId);
    // Rolled once: 300 carried debt + 50 spent in the new window = 350. A
    // double-roll would re-clamp/zero; a lost spend would read 300.
    expect(usage.usedTokens).toBe(350);
    expect(usage.resetsAt).toBe('2026-06-05T00:00:00.000Z');
    expect(await quota.isOverCap(userId)).toBe(false);
  });

  it('honors a per-account cap override', async () => {
    const quota = store();
    await quota.recordUsage(userId, 100); // creates the row
    await db
      .update(userTokenUsage)
      .set({ capOverride: 5000 })
      .where(eq(userTokenUsage.userId, userId));

    const usage = await quota.getUsage(userId);
    expect(usage.capTokens).toBe(5000);
    await quota.recordUsage(userId, 4000); // 4100 total, under the override
    expect(await quota.isOverCap(userId)).toBe(false);
  });

  it('top-up raises the effective cap and revives a capped-out user', async () => {
    const quota = store();
    await quota.recordUsage(userId, DEFAULT_CAP); // exactly at the cap
    expect(await quota.isOverCap(userId)).toBe(true);

    await quota.topUp(userId, 500); // feed it
    const usage = await quota.getUsage(userId);
    expect(usage.capTokens).toBe(DEFAULT_CAP + 500);
    expect(await quota.isOverCap(userId)).toBe(false);
  });

  it('ignores non-positive top-up amounts', async () => {
    const quota = store();
    await quota.topUp(userId, 0);
    await quota.topUp(userId, -10);
    expect((await quota.getUsage(userId)).capTokens).toBe(DEFAULT_CAP);
  });

  it('does not lose a grant when two top-up calls interleave', async () => {
    const quota = store();
    await quota.recordUsage(userId, 1); // create the row up front
    await Promise.all([quota.topUp(userId, 400), quota.topUp(userId, 300)]);
    // Atomic SQL increment: both feeds land regardless of interleaving (a
    // read-modify-write on the cap would have lost one).
    expect((await quota.getUsage(userId)).capTokens).toBe(DEFAULT_CAP + 700);
  });

  it('preserves the top-up grant across a window roll', async () => {
    const quota = store();
    await quota.topUp(userId, 2000); // user fed it; cap → 3000
    await quota.recordUsage(userId, 3500); // 500 over the fed cap

    clock = new Date('2026-06-04T00:00:01.000Z');
    const usage = await quota.getUsage(userId);
    expect(usage.capTokens).toBe(DEFAULT_CAP + 2000); // grant survives the roll
    expect(usage.usedTokens).toBe(500); // carried debt under the fed cap
  });

  it('keeps tracking the configured default after a top-up', async () => {
    // A fed user must still pick up a later change to the default cap — the grant
    // lives in its own column, not folded into cap_override.
    await store().topUp(userId, 500);
    const bigger = new DrizzleTokenQuotaStore(db, {
      defaultCapTokens: 2000,
      now: () => clock,
    });
    expect((await bigger.getUsage(userId)).capTokens).toBe(2000 + 500);
  });
});

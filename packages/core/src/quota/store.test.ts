/**
 * Token quota store tests against the real PGlite database: accrual, the
 * over-cap predicate, fixed-daily window roll with clamped debt, and the
 * per-account cap override.
 */

import { type Database, userTokenUsage } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleTokenQuotaStore } from './store.js';

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
});

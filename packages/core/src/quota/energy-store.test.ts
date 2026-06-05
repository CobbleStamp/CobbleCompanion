/**
 * Companion energy store tests against the real PGlite database: accrual, the
 * exhaustion predicate, the manual top-up raising the effective cap, fixed-daily
 * window roll with clamped debt (top-up persisting across the roll), and the
 * per-account cap override.
 */

import { type Database, companionEnergy } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEnergyStore } from './energy-store.js';

const DEFAULT_CAP = 1000;

describe('DrizzleCompanionEnergyStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  // Mutable clock so tests can advance time across the daily boundary.
  let clock: Date;

  function store(): DrizzleCompanionEnergyStore {
    return new DrizzleCompanionEnergyStore(db, {
      defaultCapTokens: DEFAULT_CAP,
      now: () => clock,
    });
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    clock = new Date('2026-06-03T10:00:00.000Z');
  });

  afterEach(async () => {
    await close();
  });

  it('starts empty and reports the next UTC midnight as the reset', async () => {
    const energy = await store().getEnergy(companionId);
    expect(energy.usedTokens).toBe(0);
    expect(energy.capTokens).toBe(DEFAULT_CAP);
    expect(energy.resetsAt).toBe('2026-06-04T00:00:00.000Z');
  });

  it('accrues spend and flips exhausted at the ceiling', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 400);
    await energy.recordSpend(companionId, 300);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(700);
    expect(await energy.isExhausted(companionId)).toBe(false);

    await energy.recordSpend(companionId, 300); // → 1000, meets the cap
    expect(await energy.isExhausted(companionId)).toBe(true);
  });

  it('ignores non-positive spend and top-up amounts', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 0);
    await energy.recordSpend(companionId, -50);
    await energy.topUp(companionId, 0);
    await energy.topUp(companionId, -10);
    const snapshot = await energy.getEnergy(companionId);
    expect(snapshot.usedTokens).toBe(0);
    expect(snapshot.capTokens).toBe(DEFAULT_CAP);
  });

  it('top-up raises the effective cap and revives an exhausted companion', async () => {
    const energy = store();
    await energy.recordSpend(companionId, DEFAULT_CAP); // exhausted at the base cap
    expect(await energy.isExhausted(companionId)).toBe(true);

    await energy.topUp(companionId, 500); // feed it
    const snapshot = await energy.getEnergy(companionId);
    expect(snapshot.capTokens).toBe(DEFAULT_CAP + 500);
    expect(snapshot.usedTokens).toBe(DEFAULT_CAP);
    expect(await energy.isExhausted(companionId)).toBe(false); // can initiate again
  });

  it('rolls the window at the daily boundary, carrying clamped overage as debt', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 1300); // 300 over the 1000 cap

    clock = new Date('2026-06-04T00:00:01.000Z');
    const snapshot = await energy.getEnergy(companionId);
    expect(snapshot.usedTokens).toBe(300); // debt carried
    expect(snapshot.resetsAt).toBe('2026-06-05T00:00:00.000Z');
    expect(await energy.isExhausted(companionId)).toBe(false);
  });

  it('clamps carried debt to at most one cap (no multi-day lockout)', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 5000); // 4000 over — would be 4 windows of debt

    clock = new Date('2026-06-04T00:00:01.000Z');
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(DEFAULT_CAP);
  });

  it('preserves the top-up grant across a window roll', async () => {
    const energy = store();
    await energy.topUp(companionId, 2000); // user fed it; cap → 3000
    await energy.recordSpend(companionId, 1500);

    clock = new Date('2026-06-04T00:00:01.000Z');
    const snapshot = await energy.getEnergy(companionId);
    expect(snapshot.capTokens).toBe(DEFAULT_CAP + 2000); // grant persists
    expect(snapshot.usedTokens).toBe(0); // under cap, no debt
    expect(snapshot.resetsAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('does not lose an update when two recordSpend calls interleave', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 1); // create the row up front
    await Promise.all([energy.recordSpend(companionId, 400), energy.recordSpend(companionId, 300)]);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(701);
  });

  it('honors a per-account cap override, added to the top-up grant', async () => {
    const energy = store();
    await energy.recordSpend(companionId, 100); // creates the row
    await db
      .update(companionEnergy)
      .set({ capOverride: 5000 })
      .where(eq(companionEnergy.companionId, companionId));
    await energy.topUp(companionId, 1000); // effective cap → 6000

    const snapshot = await energy.getEnergy(companionId);
    expect(snapshot.capTokens).toBe(6000);
    await energy.recordSpend(companionId, 5000); // 5100 total, under the effective cap
    expect(await energy.isExhausted(companionId)).toBe(false);
  });
});

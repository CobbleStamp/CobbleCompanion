/**
 * Vitality wallet store — a per-companion token balance seeded at companion creation,
 * spent DOWN (floored at 0, never negative) and added UP by feeding. Backs both
 * stamina and energy (two columns on the companions row); exercised here over the
 * stamina column with a real PGlite (fakes-over-mocks).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleVitalityStore } from './vitality-store.js';

/** Matches the seed `DrizzleIdentityStore` writes to a new companion's wallets. */
const START = 1_000_000;

describe('DrizzleVitalityStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let identity: DrizzleIdentityStore;
  let ownerId: string;
  let store: DrizzleVitalityStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db, { startingVitalityTokens: START });
    const user = await identity.ensureUserByEmail('owner@example.com');
    ownerId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    store = new DrizzleVitalityStore(db, 'stamina');
  });
  afterEach(async () => {
    await close();
  });

  it('reports the starting balance the companion was created with', async () => {
    expect(await store.getBalance(companionId)).toBe(START);
    expect(await store.isEmpty(companionId)).toBe(false);
  });

  it('spend decrements the balance', async () => {
    await store.spend(companionId, 250_000);
    expect(await store.getBalance(companionId)).toBe(START - 250_000);
  });

  it('overspend floors at 0 and never goes negative', async () => {
    await store.spend(companionId, START + 500_000); // more than the whole wallet
    expect(await store.getBalance(companionId)).toBe(0);
    expect(await store.isEmpty(companionId)).toBe(true);
  });

  it('add increments the balance (feeding)', async () => {
    await store.spend(companionId, START); // empty it first
    expect(await store.isEmpty(companionId)).toBe(true);
    await store.add(companionId, 300_000);
    expect(await store.getBalance(companionId)).toBe(300_000);
    expect(await store.isEmpty(companionId)).toBe(false);
  });

  it('isEmpty is true exactly at 0', async () => {
    await store.spend(companionId, START);
    expect(await store.getBalance(companionId)).toBe(0);
    expect(await store.isEmpty(companionId)).toBe(true);
  });

  it('spending on one companion does not affect another owned by the same user', async () => {
    const sibling = await identity.createCompanion(ownerId, {
      name: 'Quill',
      form: 'owl',
      temperament: 'watchful',
    });
    await store.spend(companionId, 400_000);
    // The fed companion dropped; the sibling's wallet is its own (still seeded full).
    expect(await store.getBalance(companionId)).toBe(START - 400_000);
    expect(await store.getBalance(sibling.id)).toBe(START);
  });
});

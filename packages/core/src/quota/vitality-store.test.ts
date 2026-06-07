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
import { CompanionNotFoundError, DrizzleVitalityStore } from './vitality-store.js';

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

  it('add clamps at Number.MAX_SAFE_INTEGER so the balance never marshals lossily', async () => {
    // bigint columns read back through drizzle `mode: 'number'`, so a balance above
    // 2^53-1 would silently lose precision on the way out. `add` caps the column at
    // the largest exactly-representable integer so every getBalance read is exact.
    // (Purely a marshaling safety net — unreachable at real 1M/200k token sizes.)
    await store.add(companionId, Number.MAX_SAFE_INTEGER);
    expect(await store.getBalance(companionId)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('isEmpty is true exactly at 0', async () => {
    await store.spend(companionId, START);
    expect(await store.getBalance(companionId)).toBe(0);
    expect(await store.isEmpty(companionId)).toBe(true);
  });

  it('spend throws CompanionNotFoundError for a missing companion (no phantom success)', async () => {
    await expect(store.spend('00000000-0000-0000-0000-000000000000', 1000)).rejects.toThrow(
      CompanionNotFoundError,
    );
  });

  it('add throws CompanionNotFoundError for a missing companion (no phantom success)', async () => {
    await expect(store.add('00000000-0000-0000-0000-000000000000', 1000)).rejects.toThrow(
      CompanionNotFoundError,
    );
  });

  it('non-positive amounts stay no-ops even for a missing companion', async () => {
    // The amount guard short-circuits before the row check — a 0-token spend/add is a
    // no-op, so it never reaches (or needs) the existence check.
    await expect(store.spend('00000000-0000-0000-0000-000000000000', 0)).resolves.toBeUndefined();
    await expect(store.add('00000000-0000-0000-0000-000000000000', 0)).resolves.toBeUndefined();
  });

  it('a negative spend cannot credit the wallet (guard at the SQL boundary)', async () => {
    // Without the guard, `GREATEST(0, balance - (-n))` = `balance + n` would turn a
    // spend into a feed. Prove a caller passing a negative amount can't inflate it.
    await store.spend(companionId, -100_000);
    expect(await store.getBalance(companionId)).toBe(START);
  });

  it('a negative add cannot drain the wallet (guard at the SQL boundary)', async () => {
    await store.add(companionId, -100_000);
    expect(await store.getBalance(companionId)).toBe(START);
  });

  it('non-finite amounts (NaN, Infinity) are no-ops and never poison the balance', async () => {
    // `NaN <= 0` is false, so a bare `<= 0` check would let NaN through to the bigint
    // column. The `Number.isFinite` guard catches NaN and ±Infinity for both ops.
    await store.spend(companionId, NaN);
    await store.spend(companionId, Infinity);
    await store.add(companionId, NaN);
    await store.add(companionId, -Infinity);
    expect(await store.getBalance(companionId)).toBe(START);
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

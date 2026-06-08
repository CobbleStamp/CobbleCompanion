import { companions, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from './store.js';

describe('DrizzleIdentityStore', () => {
  let db: Database;
  let identity: DrizzleIdentityStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
  });

  afterEach(async () => {
    await close();
  });

  describe('startingVitalityTokens validation', () => {
    it('rejects a negative seed at construction (no corrupt wallet)', () => {
      expect(() => new DrizzleIdentityStore(db, { startingVitalityTokens: -1 })).toThrow(
        RangeError,
      );
    });

    it('rejects a fractional seed at construction (bigint column would coerce)', () => {
      expect(() => new DrizzleIdentityStore(db, { startingVitalityTokens: 1.5 })).toThrow(
        RangeError,
      );
    });

    it('rejects a non-finite seed at construction', () => {
      expect(() => new DrizzleIdentityStore(db, { startingVitalityTokens: NaN })).toThrow(
        RangeError,
      );
    });

    it('accepts a valid seed and seeds both wallets with it', async () => {
      const seeded = new DrizzleIdentityStore(db, { startingVitalityTokens: 500 });
      const owner = await seeded.ensureUserByEmail('seed@example.com');
      const companion = await seeded.createCompanion(owner.id, {
        name: 'Pebble',
        form: 'fox',
        temperament: 'curious',
      });
      // Both wallets carry the seed; the DTO doesn't expose them, so assert via SQL.
      const [row] = await db
        .select()
        .from(companions)
        .where(eq(companions.id, companion.id))
        .limit(1);
      expect(row?.staminaBalanceTokens).toBe(500);
      expect(row?.energyBalanceTokens).toBe(500);
    });

    it('accepts a zero seed (an empty wallet is valid)', () => {
      expect(() => new DrizzleIdentityStore(db, { startingVitalityTokens: 0 })).not.toThrow();
    });
  });

  it('ensureUserByEmail is idempotent', async () => {
    const first = await identity.ensureUserByEmail('ada@example.com');
    const second = await identity.ensureUserByEmail('ada@example.com');
    expect(second.id).toBe(first.id);
  });

  describe('display name', () => {
    it('defaults to null when no seed is supplied', async () => {
      const user = await identity.ensureUserByEmail('noname@example.com');
      expect(user.displayName).toBeNull();
    });

    it('seeds the display name from the Google name on first provision', async () => {
      const user = await identity.ensureUserByEmail('ada@example.com', 'Ada Lovelace');
      expect(user.displayName).toBe('Ada Lovelace');
    });

    it('treats a blank seed as absent', async () => {
      const user = await identity.ensureUserByEmail('blank@example.com', '   ');
      expect(user.displayName).toBeNull();
    });

    it('never re-clobbers an existing name on a later sign-in (set-once)', async () => {
      await identity.ensureUserByEmail('ada@example.com', 'Ada');
      // A later token carrying a different profile name must not overwrite it.
      const again = await identity.ensureUserByEmail('ada@example.com', 'Augusta');
      expect(again.displayName).toBe('Ada');
    });

    it('backfills a name onto a row that was created without one', async () => {
      const first = await identity.ensureUserByEmail('ada@example.com');
      expect(first.displayName).toBeNull();
      // onConflictDoNothing keeps the existing row, so the seed only lands on the
      // initial insert — a name learned later comes through setUserDisplayName.
      await identity.setUserDisplayName(first.id, 'Ada');
      const reread = await identity.getUserById(first.id);
      expect(reread?.displayName).toBe('Ada');
    });

    it('setUserDisplayName overrides the Google seed (the confirmed name wins)', async () => {
      const user = await identity.ensureUserByEmail('ada@example.com', 'Ada Lovelace');
      await identity.setUserDisplayName(user.id, 'Ada');
      const reread = await identity.getUserById(user.id);
      expect(reread?.displayName).toBe('Ada');
    });
  });

  it('scopes getCompanion by owner (tenancy)', async () => {
    const owner = await identity.ensureUserByEmail('owner@example.com');
    const other = await identity.ensureUserByEmail('other@example.com');
    const companion = await identity.createCompanion(owner.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });

    expect(await identity.getCompanion(companion.id, owner.id)).not.toBeNull();
    expect(await identity.getCompanion(companion.id, other.id)).toBeNull();
  });

  it('getCompanionById returns the full background record (owner + persona state), unscoped', async () => {
    const owner = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(owner.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });

    const record = await identity.getCompanionById(companion.id);
    expect(record?.ownerId).toBe(owner.id);
    expect(record?.name).toBe('Pebble');
    // Phase 2 personality state defaults are exposed for background workers.
    expect(record?.evolvedPersona).toBeNull();
    expect(record?.personaUpdatedThroughSeq).toBe(0);
    expect(record?.consolidatedThroughSeq).toBe(0);

    expect(await identity.getCompanionById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('updateEvolvedPersona persists the persona and advances the evolution cursor', async () => {
    const owner = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(owner.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });

    await identity.updateEvolvedPersona(companion.id, "You've grown warmer with them.", 12);

    const record = await identity.getCompanionById(companion.id);
    expect(record?.evolvedPersona).toBe("You've grown warmer with them.");
    expect(record?.personaUpdatedThroughSeq).toBe(12);
    // The seed temperament is untouched — evolution is additive.
    expect(record?.temperament).toBe('curious');
    // It surfaces on the owner-scoped DTO too.
    const dto = await identity.getCompanion(companion.id, owner.id);
    expect(dto?.evolvedPersona).toBe("You've grown warmer with them.");
  });

  it("lists only the owner's companions", async () => {
    const owner = await identity.ensureUserByEmail('owner@example.com');
    await identity.createCompanion(owner.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    const list = await identity.listCompanions(owner.id);
    expect(list).toHaveLength(1);
  });
});

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

  it('ensureUserByClaim provisions a service user keyed by (client_id, external_id), no email', async () => {
    const externalId = '11111111-2222-4333-8444-555555555555';
    const user = await identity.ensureUserByClaim({
      authSource: 'service',
      clientId: 'sprout',
      externalId,
    });
    expect(user.authSource).toBe('service');
    expect(user.serviceClientId).toBe('sprout');
    expect(user.externalId).toBe(externalId);
    expect(user.email).toBeNull();
  });

  it('ensureUserByClaim is idempotent for a service claim', async () => {
    const claim = {
      authSource: 'service',
      clientId: 'sprout',
      externalId: '22222222-3333-4444-8555-666666666666',
    } as const;
    const first = await identity.ensureUserByClaim(claim);
    const second = await identity.ensureUserByClaim(claim);
    expect(second.id).toBe(first.id);
  });

  it('namespaces external_id by client_id (same id, different client = different user)', async () => {
    const externalId = '33333333-4444-4555-8666-777777777777';
    const sprout = await identity.ensureUserByClaim({
      authSource: 'service',
      clientId: 'sprout',
      externalId,
    });
    const acme = await identity.ensureUserByClaim({
      authSource: 'service',
      clientId: 'acme',
      externalId,
    });
    expect(acme.id).not.toBe(sprout.id);
  });

  it('keeps google and service identities distinct', async () => {
    const google = await identity.ensureUserByClaim({
      authSource: 'google',
      email: 'shared@example.com',
    });
    const service = await identity.ensureUserByClaim({
      authSource: 'service',
      clientId: 'sprout',
      externalId: '44444444-5555-4666-8777-888888888888',
    });
    expect(service.id).not.toBe(google.id);
    expect(google.externalId).toBeNull();
    expect(service.email).toBeNull();
  });

  // The user's NAME moved out of `users` to a Tier-1 `user_fact` — its seed/set-once/
  // resurrection behaviour is now covered by user-model/store.test.ts (`seedName`).

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

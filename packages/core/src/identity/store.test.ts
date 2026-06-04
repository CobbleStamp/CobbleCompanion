import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from './store.js';

describe('DrizzleIdentityStore', () => {
  let identity: DrizzleIdentityStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    identity = new DrizzleIdentityStore(created.db);
  });

  afterEach(async () => {
    await close();
  });

  it('ensureUserByEmail is idempotent', async () => {
    const first = await identity.ensureUserByEmail('ada@example.com');
    const second = await identity.ensureUserByEmail('ada@example.com');
    expect(second.id).toBe(first.id);
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

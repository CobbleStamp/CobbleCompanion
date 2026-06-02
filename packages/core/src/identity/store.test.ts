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

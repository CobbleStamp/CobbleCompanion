import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAuthTokenStore } from './auth-store.js';
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

describe('DrizzleAuthTokenStore', () => {
  let auth: DrizzleAuthTokenStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    auth = new DrizzleAuthTokenStore(created.db);
  });

  afterEach(async () => {
    await close();
  });

  it('consumes a valid token exactly once', async () => {
    const now = new Date('2026-06-02T00:00:00Z');
    const later = new Date('2026-06-02T00:10:00Z');
    await auth.createToken('ada@example.com', 'tok-1', later);

    expect(await auth.consumeToken('tok-1', now)).toBe('ada@example.com');
    // Second consumption fails — single use.
    expect(await auth.consumeToken('tok-1', now)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const issuedExpiry = new Date('2026-06-02T00:00:00Z');
    const afterExpiry = new Date('2026-06-02T01:00:00Z');
    await auth.createToken('ada@example.com', 'tok-2', issuedExpiry);
    expect(await auth.consumeToken('tok-2', afterExpiry)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await auth.consumeToken('nope', new Date())).toBeNull();
  });
});

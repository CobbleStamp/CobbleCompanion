/** The live embodiment claim: force-claim (newer wins), TTL takeover, fencing. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@cobble/db/testing';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEmbodimentStore } from './store.js';

const TTL = 60_000;

describe('DrizzleEmbodimentStore', () => {
  let store: DrizzleEmbodimentStore;
  let close: () => Promise<void>;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleEmbodimentStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  it('claims an unheld companion', async () => {
    const claim = await store.claim({ companionId, owner: 'owner-aaa', node: 'n1', ttlMs: TTL });
    expect(claim).toMatchObject({ companionId, owner: 'owner-aaa', generation: 1 });
    expect(await store.holds(companionId, 'owner-aaa')).toBe(true);
  });

  it('lets a newer ULID force-claim, superseding the prior holder', async () => {
    await store.claim({ companionId, owner: 'owner-aaa', node: 'n1', ttlMs: TTL });
    const taken = await store.claim({ companionId, owner: 'owner-bbb', node: 'n2', ttlMs: TTL });

    expect(taken).toMatchObject({ owner: 'owner-bbb', generation: 2 });
    expect(await store.holds(companionId, 'owner-bbb')).toBe(true);
    expect(await store.holds(companionId, 'owner-aaa')).toBe(false);
    // The superseded holder's heartbeat fails — it must self-fence and close.
    expect(await store.renew(companionId, 'owner-aaa')).toBe(false);
    expect(await store.renew(companionId, 'owner-bbb')).toBe(true);
  });

  it('refuses an older ULID while the holder is live', async () => {
    await store.claim({ companionId, owner: 'owner-bbb', node: 'n1', ttlMs: TTL });
    const lost = await store.claim({ companionId, owner: 'owner-aaa', node: 'n2', ttlMs: TTL });
    expect(lost).toBeNull();
    expect(await store.holds(companionId, 'owner-bbb')).toBe(true);
  });

  it('reclaims a holder whose heartbeat has lapsed (crash backstop), even an older ULID', async () => {
    await store.claim({ companionId, owner: 'owner-bbb', node: 'n1', ttlMs: TTL });
    // Let the clock advance, then claim with a 1ms TTL so the prior heartbeat is "dead".
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = await store.claim({ companionId, owner: 'owner-aaa', node: 'n2', ttlMs: 1 });
    expect(reclaimed).toMatchObject({ owner: 'owner-aaa' });
    expect(await store.holds(companionId, 'owner-bbb')).toBe(false);
  });

  it('releases only when still the owner', async () => {
    await store.claim({ companionId, owner: 'owner-aaa', node: 'n1', ttlMs: TTL });
    await store.claim({ companionId, owner: 'owner-bbb', node: 'n2', ttlMs: TTL });
    // The old holder's release is a no-op (it no longer owns the row).
    await store.release(companionId, 'owner-aaa');
    expect(await store.holds(companionId, 'owner-bbb')).toBe(true);
    // The current holder's release frees it.
    await store.release(companionId, 'owner-bbb');
    expect(await store.current(companionId, TTL)).toBeNull();
  });

  it('reports the current live claim', async () => {
    expect(await store.current(companionId, TTL)).toBeNull();
    await store.claim({ companionId, owner: 'owner-aaa', node: 'n1', ttlMs: TTL });
    expect(await store.current(companionId, TTL)).toMatchObject({ owner: 'owner-aaa' });
  });
});

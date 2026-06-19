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
    const claim = await store.claim({
      companionId,
      connectionId: 'conn-aaa',
      node: 'n1',
      ttlMs: TTL,
    });
    expect(claim).toMatchObject({ companionId, connectionId: 'conn-aaa', claimSeq: 1 });
    expect(await store.holds(companionId, 'conn-aaa', 1)).toBe(true);
  });

  it('lets a newer ULID force-claim, superseding the prior holder', async () => {
    await store.claim({ companionId, connectionId: 'conn-aaa', node: 'n1', ttlMs: TTL });
    const taken = await store.claim({
      companionId,
      connectionId: 'conn-bbb',
      node: 'n2',
      ttlMs: TTL,
    });

    expect(taken).toMatchObject({ connectionId: 'conn-bbb', claimSeq: 2 });
    expect(await store.holds(companionId, 'conn-bbb', 2)).toBe(true);
    expect(await store.holds(companionId, 'conn-aaa', 1)).toBe(false);
    // The superseded holder's heartbeat fails — it must self-fence and close.
    expect(await store.renew(companionId, 'conn-aaa', 1)).toBe(false);
    expect(await store.renew(companionId, 'conn-bbb', 2)).toBe(true);
  });

  it('refuses an older ULID while the holder is live', async () => {
    await store.claim({ companionId, connectionId: 'conn-bbb', node: 'n1', ttlMs: TTL });
    const lost = await store.claim({
      companionId,
      connectionId: 'conn-aaa',
      node: 'n2',
      ttlMs: TTL,
    });
    expect(lost).toBeNull();
    expect(await store.holds(companionId, 'conn-bbb', 1)).toBe(true);
  });

  it('reclaims a holder whose heartbeat has lapsed (crash backstop), even an older ULID', async () => {
    await store.claim({ companionId, connectionId: 'conn-bbb', node: 'n1', ttlMs: TTL });
    // Let the clock advance, then claim with a 1ms TTL so the prior heartbeat is "dead".
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = await store.claim({
      companionId,
      connectionId: 'conn-aaa',
      node: 'n2',
      ttlMs: 1,
    });
    expect(reclaimed).toMatchObject({ connectionId: 'conn-aaa' });
    expect(await store.holds(companionId, 'conn-bbb', 1)).toBe(false);
  });

  it('fences a stale claim by claim seq, even if a superseded ULID later recurs (ABA guard)', async () => {
    // A holds the room at claim seq 1.
    const a = await store.claim({ companionId, connectionId: 'conn-aaa', node: 'n1', ttlMs: TTL });
    expect(a).toMatchObject({ connectionId: 'conn-aaa', claimSeq: 1 });
    // A newer connection supersedes A.
    await store.claim({ companionId, connectionId: 'conn-bbb', node: 'n2', ttlMs: TTL });
    // The holder's heartbeat lapses, then a brand-new connection happens to reuse A's
    // ULID — the speculative cross-node collision the claim seq guards against.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reborn = await store.claim({
      companionId,
      connectionId: 'conn-aaa',
      node: 'n3',
      ttlMs: 1,
    });
    expect(reborn).toMatchObject({ connectionId: 'conn-aaa', claimSeq: 3 });
    // The live claim holds at its own claim seq...
    expect(await store.holds(companionId, 'conn-aaa', 3)).toBe(true);
    // ...but original A — same connectionId string, stale claim seq — stays fenced out.
    expect(await store.holds(companionId, 'conn-aaa', 1)).toBe(false);
  });

  it('releases only when still the holder', async () => {
    await store.claim({ companionId, connectionId: 'conn-aaa', node: 'n1', ttlMs: TTL });
    await store.claim({ companionId, connectionId: 'conn-bbb', node: 'n2', ttlMs: TTL });
    // The old holder's release is a no-op (it no longer owns the row).
    await store.release(companionId, 'conn-aaa');
    expect(await store.holds(companionId, 'conn-bbb', 2)).toBe(true);
    // The current holder's release frees it.
    await store.release(companionId, 'conn-bbb');
    expect(await store.current(companionId, TTL)).toBeNull();
  });

  it('reports the current live claim', async () => {
    expect(await store.current(companionId, TTL)).toBeNull();
    await store.claim({ companionId, connectionId: 'conn-aaa', node: 'n1', ttlMs: TTL });
    expect(await store.current(companionId, TTL)).toMatchObject({ connectionId: 'conn-aaa' });
  });
});

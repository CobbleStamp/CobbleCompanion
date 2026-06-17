/** Presence derived from the embodiment claim: live claim = present; lapsed = absent. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@cobble/db/testing';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEmbodimentStore } from './store.js';
import { EmbodimentPresenceStore } from './presence.js';

const TTL = 60_000;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('EmbodimentPresenceStore', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db'];
  let claims: DrizzleEmbodimentStore;
  let presence: EmbodimentPresenceStore;
  let close: () => Promise<void>;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    claims = new DrizzleEmbodimentStore(created.db);
    presence = new EmbodimentPresenceStore(created.db, TTL);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    companionId = (
      await identity.createCompanion(user.id, {
        name: 'Pebble',
        form: 'fox',
        temperament: 'curious',
      })
    ).id;
  });

  afterEach(async () => {
    await close();
  });

  it('is absent (null) with no live claim', async () => {
    expect(await presence.get(companionId)).toBeNull();
  });

  it('is present once a claim is held, foregrounded by default', async () => {
    await claims.claim({ companionId, owner: 'o1', node: 'n1', ttlMs: TTL });
    const signal = await presence.get(companionId);
    expect(signal).not.toBeNull();
    expect(signal?.tabVisible).toBe(true);
    expect(signal?.lastActivityAt).toBeInstanceOf(Date);
  });

  it('records activity (bumps last activity) and visibility on the claim', async () => {
    await claims.claim({ companionId, owner: 'o1', node: 'n1', ttlMs: TTL });
    presence.recordHeartbeat(companionId, { tabVisible: false });
    await settle();
    expect((await presence.get(companionId))?.tabVisible).toBe(false);

    presence.recordActivity(companionId);
    await settle();
    expect((await presence.get(companionId))?.tabVisible).toBe(true);
  });

  it('becomes absent when the claim lapses past the TTL', async () => {
    // A presence view with a 1ms TTL over the same db: a beat after the claim's
    // heartbeat, the claim is "stale" and presence reads absent.
    const shortTtl = new EmbodimentPresenceStore(db, 1);
    await claims.claim({ companionId, owner: 'o1', node: 'n1', ttlMs: TTL });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await shortTtl.get(companionId)).toBeNull();
  });
});

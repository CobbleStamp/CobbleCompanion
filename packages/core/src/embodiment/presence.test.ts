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
    await claims.claim({ companionId, connectionId: 'o1', node: 'n1', ttlMs: TTL });
    const signal = await presence.get(companionId);
    expect(signal).not.toBeNull();
    expect(signal?.tabVisible).toBe(true);
    expect(signal?.lastActivityAt).toBeInstanceOf(Date);
  });

  it('records activity (bumps last activity) and visibility on the claim', async () => {
    await claims.claim({ companionId, connectionId: 'o1', node: 'n1', ttlMs: TTL });
    const fence = { connectionId: 'o1', claimSeq: 1 };
    presence.recordHeartbeat(companionId, { tabVisible: false, fence });
    await settle();
    expect((await presence.get(companionId))?.tabVisible).toBe(false);

    presence.recordActivity(companionId, fence);
    await settle();
    expect((await presence.get(companionId))?.tabVisible).toBe(true);
  });

  it('ignores a write fenced to a superseded claim (no stomp of the successor)', async () => {
    // o1 claims, then a newer connection o2 force-claims (its later write wins the
    // room, bumping claimSeq to 2 and setting tabVisible=true). A late write from
    // the superseded o1 must NOT flip the live successor's presence.
    await claims.claim({ companionId, connectionId: 'o1', node: 'n1', ttlMs: TTL });
    await claims.claim({ companionId, connectionId: 'o2', node: 'n1', ttlMs: TTL });

    // o1's stale fence (connectionId o1, claimSeq 1) no longer matches the row.
    presence.recordHeartbeat(companionId, {
      tabVisible: false,
      fence: { connectionId: 'o1', claimSeq: 1 },
    });
    await settle();
    // Successor o2's foregrounded presence is intact — the stale write was a no-op.
    expect((await presence.get(companionId))?.tabVisible).toBe(true);

    // The live holder o2 (claimSeq 2) can still update presence.
    presence.recordHeartbeat(companionId, {
      tabVisible: false,
      fence: { connectionId: 'o2', claimSeq: 2 },
    });
    await settle();
    expect((await presence.get(companionId))?.tabVisible).toBe(false);
  });

  it('becomes absent when the claim lapses past the TTL', async () => {
    // A presence view with a 1ms TTL over the same db: a beat after the claim's
    // heartbeat, the claim is "stale" and presence reads absent.
    const shortTtl = new EmbodimentPresenceStore(db, 1);
    await claims.claim({ companionId, connectionId: 'o1', node: 'n1', ttlMs: TTL });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await shortTtl.get(companionId)).toBeNull();
  });
});

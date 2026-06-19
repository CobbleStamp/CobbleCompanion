import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEmbodimentStore } from './store.js';
import { createPgDatabase } from '@cobble/db';
import { createIntegrationDatabase, type IntegrationDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TTL_MS = 30_000;

/**
 * The real-Postgres counterpart to the embodiment claim logic. Exactly one WS
 * connection may hold a companion (deliver-scalability.md §5.2). The "newer ULID
 * wins / live holder keeps it" gate is an `INSERT … ON CONFLICT DO UPDATE …
 * setWhere` — a property PGlite's single connection cannot race. Here two
 * connections over *separate pools* contend, and we assert the fence holds,
 * including the ABA case the DB-stamped `claimSeq` exists to defend against.
 */
describe('DrizzleEmbodimentStore concurrency (real Postgres)', () => {
  let integration: IntegrationDatabase;
  let companionId: string;

  // ULIDs are lexically sortable; `older` < `newer` so the newer connection wins.
  const older = '01HZZZZZZZZZZZZZZZZZZZZZZZA';
  const newer = '01HZZZZZZZZZZZZZZZZZZZZZZZB';

  beforeEach(async () => {
    integration = await createIntegrationDatabase();
    const identity = new DrizzleIdentityStore(integration.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await integration.close();
  });

  it('lets exactly one of two concurrent first-claims win', async () => {
    const a = createPgDatabase(integration.connectionString);
    const b = createPgDatabase(integration.connectionString);
    try {
      const storeA = new DrizzleEmbodimentStore(a.db);
      const storeB = new DrizzleEmbodimentStore(b.db);
      const [claimA, claimB] = await Promise.all([
        storeA.claim({ companionId, connectionId: older, node: 'node-a', ttlMs: TTL_MS }),
        storeB.claim({ companionId, connectionId: newer, node: 'node-b', ttlMs: TTL_MS }),
      ]);

      // The PK ON CONFLICT serialises the two inserts: one is a fresh insert, the
      // other an UPDATE gated by setWhere. Exactly one ends up the live holder.
      const live = await new DrizzleEmbodimentStore(integration.db).current(companionId, TTL_MS);
      expect(live).not.toBeNull();

      // Whoever currently holds it must report a successful claim; a superseded
      // attempt either returned null or was overwritten.
      const holders = [claimA, claimB].filter(
        (claim) => claim?.connectionId === live?.connectionId,
      );
      expect(holders).toHaveLength(1);
    } finally {
      await a.pool.end();
      await b.pool.end();
    }
  });

  it('lets a newer connection take over a live holder, and fences the old one', async () => {
    const store = new DrizzleEmbodimentStore(integration.db);
    const first = await store.claim({
      companionId,
      connectionId: older,
      node: 'node-a',
      ttlMs: TTL_MS,
    });
    expect(first?.claimSeq).toBe(1);

    const second = await store.claim({
      companionId,
      connectionId: newer,
      node: 'node-b',
      ttlMs: TTL_MS,
    });
    expect(second?.connectionId).toBe(newer);
    expect(second?.claimSeq).toBe(2);

    // The superseded connection no longer holds — and crucially, its old
    // (connectionId, claimSeq) binding is fenced even though the row still exists.
    expect(await store.holds(companionId, older, 1)).toBe(false);
    expect(await store.holds(companionId, newer, 2)).toBe(true);
  });

  it('fences a recurring connectionId via claimSeq (ABA case)', async () => {
    const store = new DrizzleEmbodimentStore(integration.db);
    // `older` (id=A) claims, then `newer` (id=B) takes over: seq 1 → 2.
    await store.claim({ companionId, connectionId: older, node: 'n1', ttlMs: TTL_MS });
    await store.claim({ companionId, connectionId: newer, node: 'n2', ttlMs: TTL_MS });

    // B's heartbeat lapses and the id=A *recurs* on a fresh connection. It wins the
    // row via the dead-holder backstop (not the ULID comparison: A < B is false),
    // bumping seq to 3 with connectionId back to A.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recurred = await store.claim({ companionId, connectionId: older, node: 'n3', ttlMs: 1 });
    expect(recurred?.connectionId).toBe(older);
    expect(recurred?.claimSeq).toBe(3);

    // The original A binding (id=A, seq=1) is fenced even though id=A holds again —
    // the DB-stamped claimSeq, not the recurring id, is the identity that matters.
    expect(await store.holds(companionId, older, 1)).toBe(false);
    expect(await store.holds(companionId, older, 3)).toBe(true);
  });

  it('renew fences a superseded connection in the ABA case', async () => {
    const store = new DrizzleEmbodimentStore(integration.db);
    // A (id=older) claims seq=1, B (id=newer) takes over seq=2.
    await store.claim({ companionId, connectionId: older, node: 'n1', ttlMs: TTL_MS });
    await store.claim({ companionId, connectionId: newer, node: 'n2', ttlMs: TTL_MS });

    // B's heartbeat lapses and id=older *recurs* on a fresh connection, winning the
    // row via the dead-holder backstop → row is now (connectionId=older, claimSeq=3).
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recurred = await store.claim({ companionId, connectionId: older, node: 'n3', ttlMs: 1 });
    expect(recurred?.claimSeq).toBe(3);

    // The ORIGINAL A (its real claim was seq=1) must NOT be able to renew — otherwise
    // its heartbeat keeps a superseded connection alive and delivering live events.
    // renew must fence on claimSeq exactly as holds does, not on (companionId,
    // connectionId) alone — which the recurring id=older would wrongly satisfy.
    expect(await store.renew(companionId, older, 1)).toBe(false);
    expect(await store.renew(companionId, older, 3)).toBe(true);
  });
});

/**
 * The C2 observability snapshot (deliver-scalability.md §C). Drives the real job
 * queue + embodiment store over an in-memory PGlite db and asserts the reader
 * reports the true fleet-wide picture: depth by type, oldest-due age, failures,
 * and live job/embodiment claims. The reclaimed-claim count is exercised with a
 * directly-inserted generation>1 row (the reclaim *timing* is the known Q1 flake,
 * so we assert the reader's read of it, not the claim race).
 */

import { activeEmbodiment, companionClaims, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleEmbodimentStore } from '../embodiment/store.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleJobQueue } from './job-queue.js';
import { DrizzleQueueMetricsReader } from './queue-metrics.js';

const TTL_MS = 30_000;

describe('DrizzleQueueMetricsReader', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let queue: DrizzleJobQueue;
  let embodiment: DrizzleEmbodimentStore;
  let reader: DrizzleQueueMetricsReader;

  async function newCompanion(name: string): Promise<string> {
    const user = await identity.ensureUserByEmail(`${name}@example.com`);
    const companion = await identity.createCompanion(user.id, {
      name,
      form: 'fox',
      temperament: 'curious',
    });
    return companion.id;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    queue = new DrizzleJobQueue(db);
    embodiment = new DrizzleEmbodimentStore(db);
    reader = new DrizzleQueueMetricsReader(db, TTL_MS);
  });
  afterEach(async () => {
    await close();
  });

  it('reports an all-zero snapshot on an empty queue', async () => {
    const snap = await reader.snapshot();
    expect(snap).toEqual({
      pendingDue: 0,
      pendingTotal: 0,
      pendingByType: { consolidate: 0, motivation: 0, reaction_learn: 0, ingest: 0 },
      oldestPendingDueAgeMs: null,
      failedTotal: 0,
      failedByType: { consolidate: 0, motivation: 0, reaction_learn: 0, ingest: 0 },
      liveJobClaims: 0,
      reclaimedJobClaims: 0,
      liveEmbodiments: 0,
    });
  });

  it('counts pending depth by type and separates future-dated from due', async () => {
    const c1 = await newCompanion('alpha');
    const c2 = await newCompanion('bravo');
    await queue.enqueue({ companionId: c1, type: 'consolidate' });
    await queue.enqueue({ companionId: c1, type: 'motivation' });
    await queue.enqueue({ companionId: c2, type: 'consolidate' });
    // Future-dated: counts toward total but not due.
    await queue.enqueue({
      companionId: c2,
      type: 'ingest',
      runAt: new Date(Date.now() + 60_000),
    });

    const snap = await reader.snapshot();
    expect(snap.pendingByType).toEqual({
      consolidate: 2,
      motivation: 1,
      reaction_learn: 0,
      ingest: 0, // the only ingest job is future-dated, so not due
    });
    expect(snap.pendingDue).toBe(3);
    expect(snap.pendingTotal).toBe(4);
  });

  it('reports a non-null oldest-due age once work is overdue', async () => {
    const c1 = await newCompanion('alpha');
    await queue.enqueue({
      companionId: c1,
      type: 'consolidate',
      runAt: new Date(Date.now() - 5_000),
    });
    const snap = await reader.snapshot();
    expect(snap.oldestPendingDueAgeMs).not.toBeNull();
    expect(snap.oldestPendingDueAgeMs ?? 0).toBeGreaterThanOrEqual(4_000);
  });

  it('counts failed jobs by type and excludes them from pending', async () => {
    const c1 = await newCompanion('alpha');
    await queue.enqueue({ companionId: c1, type: 'reaction_learn', dedupeKey: 'r:1' });
    const claim = await queue.claimNextCompanion('node-1', 60_000);
    expect(claim?.companionId).toBe(c1);
    const job = await queue.nextDueJob(c1);
    expect(job).not.toBeNull();
    await queue.markFailed(job!.id, 'boom', claim!);

    const snap = await reader.snapshot();
    expect(snap.failedTotal).toBe(1);
    expect(snap.failedByType.reaction_learn).toBe(1);
    expect(snap.pendingDue).toBe(0);
  });

  it('counts live job claims and flags reclaimed (generation>1) ones', async () => {
    const c1 = await newCompanion('alpha');
    const c2 = await newCompanion('bravo');
    await queue.enqueue({ companionId: c1, type: 'consolidate' });
    // A freshly-claimed companion (generation 1, live).
    await queue.claimNextCompanion('node-1', 60_000);
    // A directly-inserted reclaimed claim (generation 2, live) — the failover signal.
    await db.insert(companionClaims).values({
      companionId: c2,
      owner: 'node-2',
      generation: 2,
      claimedUntil: new Date(Date.now() + 60_000),
    });

    const snap = await reader.snapshot();
    expect(snap.liveJobClaims).toBe(2);
    expect(snap.reclaimedJobClaims).toBe(1);
  });

  it('excludes expired job claims from the live count', async () => {
    const c1 = await newCompanion('alpha');
    await db.insert(companionClaims).values({
      companionId: c1,
      owner: 'node-1',
      generation: 1,
      claimedUntil: new Date(Date.now() - 1_000), // lapsed
    });
    const snap = await reader.snapshot();
    expect(snap.liveJobClaims).toBe(0);
  });

  it('counts live embodiments and excludes stale ones', async () => {
    const c1 = await newCompanion('alpha');
    const c2 = await newCompanion('bravo');
    await embodiment.claim({
      companionId: c1,
      connectionId: '01HOLDER',
      node: 'node-1',
      ttlMs: TTL_MS,
    });
    // A stale embodiment: last_heartbeat older than the TTL is not live.
    await db.insert(activeEmbodiment).values({
      companionId: c2,
      connectionId: '01STALE',
      node: 'node-2',
      claimSeq: 1,
      lastHeartbeat: new Date(Date.now() - TTL_MS - 5_000),
    });

    const snap = await reader.snapshot();
    expect(snap.liveEmbodiments).toBe(1);
  });
});

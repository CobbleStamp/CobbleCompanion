import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleJobQueue } from './job-queue.js';
import { createPgDatabase } from '@cobble/db';
import { createIntegrationDatabase, type IntegrationDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The real-Postgres counterpart to job-queue.test.ts. PGlite is single-connection,
 * so the *concurrent* claim race — the whole basis of Phase B's fleet-wide
 * single-writer guarantee (deliver-scalability.md §7 Q1) — has no coverage there.
 * Here two queues backed by *separate pools* (so, separate backend connections)
 * contend over the same companion, and we assert the `INSERT … ON CONFLICT DO
 * UPDATE … setWhere claimed_until < now()` gate lets exactly one win.
 */
describe('DrizzleJobQueue concurrency (real Postgres)', () => {
  let integration: IntegrationDatabase;
  let companionId: string;

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
    // One due job makes the companion a claim candidate.
    await new DrizzleJobQueue(integration.db).enqueue({
      companionId,
      type: 'motivation',
    });
  });

  afterEach(async () => {
    await integration.close();
  });

  it('lets exactly one of two concurrent claimers win', async () => {
    const a = createPgDatabase(integration.connectionString);
    const b = createPgDatabase(integration.connectionString);
    try {
      const queueA = new DrizzleJobQueue(a.db);
      const queueB = new DrizzleJobQueue(b.db);
      const [claimA, claimB] = await Promise.all([
        queueA.claimNextCompanion('node-a', 30_000),
        queueB.claimNextCompanion('node-b', 30_000),
      ]);

      const winners = [claimA, claimB].filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.companionId).toBe(companionId);
      expect(winners[0]?.generation).toBe(1);
    } finally {
      await a.pool.end();
      await b.pool.end();
    }
  });

  it('lets a second claimer take over only after the lease expires', async () => {
    const queue = new DrizzleJobQueue(integration.db);
    // A 1ms lease so it is already expired by the time the second claim runs.
    const first = await queue.claimNextCompanion('node-a', 1);
    expect(first?.companionId).toBe(companionId);

    // Wait past the lease, then a different owner reclaims (generation bumps).
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await queue.claimNextCompanion('node-b', 30_000);
    expect(second?.companionId).toBe(companionId);
    expect(second?.owner).toBe('node-b');
    expect(second?.generation).toBe(2);
  });
});

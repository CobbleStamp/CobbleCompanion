import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { DrizzleJobQueue, reactionLearnDedupeKey } from './job-queue.js';
import { JobProcessorPool, type JobHandlers } from './job-processor.js';
import { companionClaims, jobs, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { and, eq, lte, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const silentLogger: Logger = { error() {}, warn() {}, info() {} };

/**
 * Test-local probe for the count of pending jobs that are due now. The queue no
 * longer exposes this (it had no production caller); tests observe the state
 * directly so lifecycle assertions stay meaningful.
 */
async function countDuePending(db: Database): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, sql`now()`)));
  return rows[0]?.n ?? 0;
}

/**
 * Logic-level tests on in-memory PGlite. NOTE: PGlite is single-connection, so
 * the *concurrent* claim races (two nodes contending) are not exercised here —
 * they run against real Postgres in `job-queue.integration.test.ts`
 * (`make test-integration`). These cover the SQL shape and single-threaded
 * semantics.
 */
describe('DrizzleJobQueue', () => {
  let db: Database;
  let queue: DrizzleJobQueue;
  let close: () => Promise<void>;
  let companionA: string;
  let companionB: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    queue = new DrizzleJobQueue(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const a = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    const b = await identity.createCompanion(user.id, {
      name: 'Cobble',
      form: 'dog',
      temperament: 'playful',
    });
    companionA = a.id;
    companionB = b.id;
  });

  afterEach(async () => {
    await close();
  });

  async function drainClaimed(companionId: string): Promise<readonly string[]> {
    const seen: string[] = [];
    for (
      let job = await queue.nextDueJob(companionId);
      job;
      job = await queue.nextDueJob(companionId)
    ) {
      seen.push(job.dedupeKey);
      await queue.markDone(job.id);
    }
    return seen;
  }

  it('coalesces repeated pending jobs of the same (companion, type)', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    await queue.claimNextCompanion('node-1', 60_000);
    expect(await drainClaimed(companionA)).toEqual(['consolidate']); // collapsed to one
  });

  it('does not coalesce distinct reaction_learn events, but dedupes a re-react', async () => {
    await queue.enqueue({
      companionId: companionA,
      type: 'reaction_learn',
      dedupeKey: reactionLearnDedupeKey('m1', '👍'),
      payload: { messageId: 'm1', emoji: '👍' },
    });
    await queue.enqueue({
      companionId: companionA,
      type: 'reaction_learn',
      dedupeKey: reactionLearnDedupeKey('m2', '🎉'),
      payload: { messageId: 'm2', emoji: '🎉' },
    });
    // Re-react to m1/👍 while still pending → dedupes onto the first row.
    await queue.enqueue({
      companionId: companionA,
      type: 'reaction_learn',
      dedupeKey: reactionLearnDedupeKey('m1', '👍'),
      payload: { messageId: 'm1', emoji: '👍' },
    });

    await queue.claimNextCompanion('node-1', 60_000);
    expect([...(await drainClaimed(companionA))].sort()).toEqual(
      [reactionLearnDedupeKey('m1', '👍'), reactionLearnDedupeKey('m2', '🎉')].sort(),
    );
  });

  it('claims a companion exclusively until released', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    const a = await queue.claimNextCompanion('node-1', 60_000);
    expect(a?.companionId).toBe(companionA);
    // companionA is the only one with work and it is now claimed → nothing left.
    expect(await queue.claimNextCompanion('node-2', 60_000)).toBeNull();

    await queue.releaseClaim(companionA, 'node-1');
    const c = await queue.claimNextCompanion('node-2', 60_000);
    expect(c?.companionId).toBe(companionA);
  });

  it('reclaims a companion after its lease expires, bumping the generation', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    const a = await queue.claimNextCompanion('node-1', 0); // already-expired lease
    expect(a?.companionId).toBe(companionA);
    const b = await queue.claimNextCompanion('node-2', 60_000);
    expect(b?.companionId).toBe(companionA);
    expect(b!.generation).toBeGreaterThan(a!.generation);
  });

  it('hands distinct companions to distinct claimants', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionB, type: 'motivation' });

    const a = await queue.claimNextCompanion('node-1', 60_000);
    const b = await queue.claimNextCompanion('node-2', 60_000);
    expect(new Set([a?.companionId, b?.companionId])).toEqual(new Set([companionA, companionB]));
  });

  it('does not claim a job whose run_at is in the future', async () => {
    await queue.enqueue({
      companionId: companionA,
      type: 'consolidate',
      runAt: new Date(Date.now() + 60_000),
    });
    expect(await countDuePending(db)).toBe(0);
    expect(await queue.claimNextCompanion('node-1', 60_000)).toBeNull();
  });

  it('coalescing keeps the earliest run_at, so a sooner trigger wins', async () => {
    await queue.enqueue({
      companionId: companionA,
      type: 'consolidate',
      runAt: new Date(Date.now() + 60_000), // far future
    });
    await queue.enqueue({
      companionId: companionA,
      type: 'consolidate',
      runAt: new Date(Date.now() - 1000), // already due
    });
    // The two collapse onto one row carrying the earlier (due) run_at.
    expect(await countDuePending(db)).toBe(1);
    expect((await queue.claimNextCompanion('node-1', 60_000))?.companionId).toBe(companionA);
  });

  it('renewClaim extends our lease and rejects a non-owner', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.claimNextCompanion('node-1', 60_000);
    expect(await queue.renewClaim(companionA, 'node-1', 60_000)).toEqual({ held: true });
    // A non-owner's renewal fails and reports who actually holds the claim.
    expect(await queue.renewClaim(companionA, 'node-2', 60_000)).toMatchObject({
      held: false,
      reason: 'reclaimed',
      heldBy: 'node-1',
    });
  });
});

describe('JobProcessorPool', () => {
  let db: Database;
  let queue: DrizzleJobQueue;
  let close: () => Promise<void>;
  let companionA: string;
  let companionB: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    queue = new DrizzleJobQueue(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    companionA = (
      await identity.createCompanion(user.id, {
        name: 'Pebble',
        form: 'fox',
        temperament: 'curious',
      })
    ).id;
    companionB = (
      await identity.createCompanion(user.id, {
        name: 'Cobble',
        form: 'dog',
        temperament: 'playful',
      })
    ).id;
  });

  afterEach(async () => {
    await close();
  });

  it('drains queued jobs across companions via the handler, then marks them done', async () => {
    const handled: string[] = [];
    const handlers: JobHandlers = {
      consolidate: async (job) => {
        handled.push(`${job.companionId}:${job.type}`);
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 2,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      pollMs: 60_000,
      logger: silentLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionB, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    expect(handled.sort()).toEqual(
      [`${companionA}:consolidate`, `${companionB}:consolidate`].sort(),
    );
    expect(await countDuePending(db)).toBe(0);
  });

  it('marks a job failed (terminal) when its handler throws, and moves on', async () => {
    const handlers: JobHandlers = {
      consolidate: async () => {
        throw new Error('boom');
      },
      motivation: async () => {
        /* succeeds */
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      pollMs: 60_000,
      logger: silentLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionA, type: 'motivation' });

    pool.nudge();
    await pool.whenIdle();

    // Both terminal (one failed, one done) → none left pending/due, and the
    // failure didn't block the sibling job.
    expect(await countDuePending(db)).toBe(0);
  });

  it('stops draining a companion once its lease has been taken over by another node', async () => {
    const handled: string[] = [];
    const handlers: JobHandlers = {
      consolidate: async (job) => {
        handled.push(job.dedupeKey);
        // Simulate a rival node reclaiming the companion mid-drain: rewrite the
        // claim's owner so node-1's between-jobs renewClaim no longer matches.
        if (job.dedupeKey === 'first') {
          await db
            .update(companionClaims)
            .set({ owner: 'node-2' })
            .where(eq(companionClaims.companionId, companionA));
        }
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      pollMs: 60_000,
      logger: silentLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate', dedupeKey: 'first' });
    await queue.enqueue({ companionId: companionA, type: 'consolidate', dedupeKey: 'second' });

    pool.nudge();
    await pool.whenIdle();

    // The lease moved after 'first', so node-1 bails before running 'second' —
    // bounding the overlap to the one job already in flight. 'second' stays pending
    // for whichever node now holds the claim.
    expect(handled).toEqual(['first']);
    expect(await countDuePending(db)).toBe(1);
  });

  it('leaves a job pending (does not complete it) when the lease is lost mid-run', async () => {
    // A rival reclaims the companion *while* the job runs; the mid-run heartbeat
    // observes the lost lease and aborts. The job must NOT be marked done — the new
    // owner now owns it — so it stays pending for the reclaiming node (the C2 fix:
    // a lost-lease run no longer silently double-completes).
    const handlers: JobHandlers = {
      consolidate: async () => {
        await db
          .update(companionClaims)
          .set({ owner: 'node-2' })
          .where(eq(companionClaims.companionId, companionA));
        // Outlast a few heartbeat ticks so the renewal sees the rewritten owner.
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60_000,
      heartbeatMs: 10,
      pollMs: 60_000,
      logger: silentLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    // Not completed: the job is still pending+due for the node that now holds the claim.
    expect(await countDuePending(db)).toBe(1);
  });

  it('logs the handler error when the handler throws as the lease is lost mid-run', async () => {
    // A genuine handler bug coincident with lease loss must not vanish: the job
    // still stays pending (the reclaiming node re-runs it), but the thrown error
    // is the only record of the failed attempt and must be logged.
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const capturingLogger: Logger = {
      error() {},
      info() {},
      warn(message: string, context?: Record<string, unknown>) {
        warnings.push({ message, context });
      },
    };
    const handlerError = new Error('handler exploded mid-run');
    const handlers: JobHandlers = {
      consolidate: async () => {
        await db
          .update(companionClaims)
          .set({ owner: 'node-2' })
          .where(eq(companionClaims.companionId, companionA));
        // Outlast a few heartbeat ticks so the renewal sees the rewritten owner,
        // then throw — the lease is lost AND the handler failed.
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw handlerError;
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60_000,
      heartbeatMs: 10,
      pollMs: 60_000,
      logger: capturingLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    // Still pending for the reclaiming node — no outcome recorded by this node.
    expect(await countDuePending(db)).toBe(1);
    // The handler error is surfaced on the lost-lease warning, not swallowed.
    const lostLease = warnings.find((w) => w.message.includes('lease lost mid-run'));
    expect(lostLease?.context?.handlerError).toBe(handlerError);
  });
});

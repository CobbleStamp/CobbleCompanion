import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import {
  DrizzleJobQueue,
  reactionLearnDedupeKey,
  type ClaimedCompanion,
  type EnqueueParams,
  type JobQueue,
  type QueuedJob,
  type RenewOutcome,
} from './job-queue.js';
import { JobProcessorPool, type JobHandlers } from './job-processor.js';
import type { JobType } from '@cobble/shared';
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
 * Wraps a real queue and makes the first `failures` heartbeat renewals throw, as a
 * transient DB blip would. Every other call (and renewals after the blip) delegates
 * to the inner queue unchanged — so the drain sees genuine `held` outcomes once the
 * "outage" clears.
 */
class FlakyRenewQueue implements JobQueue {
  private renewCalls = 0;
  private claimCalls = 0;
  /**
   * @param failures  how many of the first `renewClaim` calls throw
   * @param maxClaims cap on `claimNextCompanion` results — once reached it returns
   *   null, so a drain that aborts and releases doesn't immediately re-claim the
   *   still-pending job and spin (there is no second node in these tests to take it)
   */
  constructor(
    private readonly inner: JobQueue,
    private readonly failures: number,
    private readonly maxClaims: number = Number.POSITIVE_INFINITY,
  ) {}

  enqueue(params: EnqueueParams): Promise<void> {
    return this.inner.enqueue(params);
  }
  claimNextCompanion(owner: string, leaseMs: number): Promise<ClaimedCompanion | null> {
    if (this.claimCalls >= this.maxClaims) return Promise.resolve(null);
    this.claimCalls += 1;
    return this.inner.claimNextCompanion(owner, leaseMs);
  }
  nextDueJob(companionId: string): Promise<QueuedJob | null> {
    return this.inner.nextDueJob(companionId);
  }
  markDone(jobId: string, claim: ClaimedCompanion): Promise<boolean> {
    return this.inner.markDone(jobId, claim);
  }
  markFailed(jobId: string, error: string, claim: ClaimedCompanion): Promise<boolean> {
    return this.inner.markFailed(jobId, error, claim);
  }
  renewClaim(companionId: string, owner: string, leaseMs: number): Promise<RenewOutcome> {
    this.renewCalls += 1;
    if (this.renewCalls <= this.failures) {
      return Promise.reject(new Error('transient: connection terminated unexpectedly'));
    }
    return this.inner.renewClaim(companionId, owner, leaseMs);
  }
  releaseClaim(companionId: string, owner: string): Promise<void> {
    return this.inner.releaseClaim(companionId, owner);
  }
  pendingCountByType(type: JobType): Promise<number> {
    return this.inner.pendingCountByType(type);
  }
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

  async function drainClaimed(claim: ClaimedCompanion): Promise<readonly string[]> {
    const seen: string[] = [];
    for (
      let job = await queue.nextDueJob(claim.companionId);
      job;
      job = await queue.nextDueJob(claim.companionId)
    ) {
      seen.push(job.dedupeKey);
      await queue.markDone(job.id, claim);
    }
    return seen;
  }

  it('coalesces repeated pending jobs of the same (companion, type)', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    const claim = await queue.claimNextCompanion('node-1', 60_000);
    expect(await drainClaimed(claim!)).toEqual(['consolidate']); // collapsed to one
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

    const claim = await queue.claimNextCompanion('node-1', 60_000);
    expect([...(await drainClaimed(claim!))].sort()).toEqual(
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

  it('fences a terminal write to the claim that ran the job (C1: stale writer rejected)', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    const stale = await queue.claimNextCompanion('node-1', 60_000);
    expect(stale).not.toBeNull();
    const job = await queue.nextDueJob(companionA);
    expect(job).not.toBeNull();

    // A rival reclaims the companion — exactly the (owner, generation) bump that
    // tryClaim's `generation + 1` produces on takeover.
    const newGeneration = stale!.generation + 1;
    await db
      .update(companionClaims)
      .set({ owner: 'node-2', generation: newGeneration })
      .where(eq(companionClaims.companionId, companionA));

    // node-1's stale terminal write matches zero rows: the job stays pending for
    // the reclaiming node rather than being stamped done by the superseded epoch.
    expect(await queue.markDone(job!.id, stale!)).toBe(false);
    const [stillPending] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(stillPending?.status).toBe('pending');

    // The reclaiming node's own claim lands the outcome.
    const fresh: ClaimedCompanion = {
      companionId: companionA,
      owner: 'node-2',
      generation: newGeneration,
    };
    expect(await queue.markDone(job!.id, fresh)).toBe(true);
    const [done] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(done?.status).toBe('done');
  });

  it('fences markFailed to the claim that ran the job (stale failure does not stomp)', async () => {
    await queue.enqueue({ companionId: companionA, type: 'consolidate' });
    const stale = await queue.claimNextCompanion('node-1', 60_000);
    const job = await queue.nextDueJob(companionA);
    await db
      .update(companionClaims)
      .set({ owner: 'node-2', generation: stale!.generation + 1 })
      .where(eq(companionClaims.companionId, companionA));

    // A stale node marking it failed must not land — `consolidate` has no retry,
    // so a stomped `failed` would silently drop work the reclaiming node completes.
    expect(await queue.markFailed(job!.id, 'boom', stale!)).toBe(false);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBeNull();
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
        // claim's owner so node-1 no longer matches — both the per-job terminal-write
        // fence and the between-jobs renewClaim now reject node-1.
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

    // node-1 ran 'first's handler but the claim moved to node-2 mid-run, so its
    // terminal write is fenced out (the C1 fix — node-1 must not stamp an outcome
    // node-2 now owns); the between-jobs check then stops it before 'second'. Both
    // jobs stay pending for whichever node now holds the claim — 'first' re-runs
    // cleanly under the idempotent-handler invariant.
    expect(handled).toEqual(['first']);
    expect(await countDuePending(db)).toBe(2);
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
        warnings.push(context === undefined ? { message } : { message, context });
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

  it('fences the terminal write when the claim is reclaimed in the heartbeat blind spot', async () => {
    // The C1 race: the lease lapses and is reclaimed *between* heartbeats, so the
    // in-process `lease.aborted` flag is still false when the job completes. With the
    // heartbeat set far longer than the (instant) job, that flag never trips — the DB
    // fence on markDone is the only backstop. The stale write must match zero rows so
    // the job stays pending for the reclaiming node, instead of node-1 stamping `done`
    // over node-2's outcome.
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const capturingLogger: Logger = {
      error() {},
      info() {},
      warn(message: string, context?: Record<string, unknown>) {
        warnings.push(context === undefined ? { message } : { message, context });
      },
    };
    const handlers: JobHandlers = {
      consolidate: async () => {
        // A rival reclaims mid-run: the (owner, generation) bump a real takeover makes.
        // claimed_until is left live, so node-1's between-jobs renewal still fails on
        // owner — but the terminal write has already happened by then.
        await db
          .update(companionClaims)
          .set({ owner: 'node-2', generation: sql`${companionClaims.generation} + 1` })
          .where(eq(companionClaims.companionId, companionA));
      },
    };
    const pool = new JobProcessorPool(queue, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60_000,
      // Far longer than the instant job, so the heartbeat never fires and
      // `lease.aborted` stays false: only the DB fence can catch the takeover.
      heartbeatMs: 60_000,
      pollMs: 60_000,
      logger: capturingLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    // Stale write fenced out: the job is still pending+due for the reclaiming node.
    expect(await countDuePending(db)).toBe(1);
    const fenced = warnings.find((w) => w.message.includes('terminal job write fenced'));
    expect(fenced?.context?.outcome).toBe('done');
    expect(fenced?.context?.jobId).toBeDefined();
  });

  it('marks a job failed when no handler is registered for its type (lease held)', async () => {
    // No handler is a deterministic, terminal failure: while we still hold the
    // lease the job is marked failed so it is not retried in a loop. (If the lease
    // had been lost before dispatch, runJob instead leaves it pending for reclaim.)
    const pool = new JobProcessorPool(
      queue,
      {},
      {
        owner: 'node-1',
        concurrency: 1,
        leaseMs: 60_000,
        heartbeatMs: 10,
        pollMs: 60_000,
        logger: silentLogger,
      },
    );

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    expect(await countDuePending(db)).toBe(0);
    const [row] = await db.select().from(jobs).where(eq(jobs.companionId, companionA));
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toContain('no handler for job type consolidate');
  });

  it('survives transient renewal errors and finishes the job instead of aborting on the first blip', async () => {
    // A few heartbeat renewals throw (a brief DB hiccup), but the lease we last
    // secured is nowhere near expiry — so the drain must tolerate the blip and run
    // the job to completion rather than abandon it for reclaim on the first error.
    const flaky = new FlakyRenewQueue(queue, 3);
    let handled = false;
    const handlers: JobHandlers = {
      consolidate: async () => {
        // Outlast several heartbeat ticks so the throwing renewals actually fire
        // while the job is in flight.
        await new Promise((resolve) => setTimeout(resolve, 80));
        handled = true;
      },
    };
    const pool = new JobProcessorPool(flaky, handlers, {
      owner: 'node-1',
      concurrency: 1,
      // leaseMs >> heartbeatMs, so 3 missed beats stay far from the near-expiry abort.
      leaseMs: 60_000,
      heartbeatMs: 10,
      pollMs: 60_000,
      logger: silentLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    // The transient errors did not abort the drain: the handler ran and the job is
    // terminal (marked done), so nothing is left pending.
    expect(handled).toBe(true);
    expect(await countDuePending(db)).toBe(0);
  });

  it('aborts the drain once renewals fail long enough to near lease expiry', async () => {
    // Every renewal throws and the lease window is short, so elapsed-since-renewal
    // crosses `leaseMs - heartbeatMs`: the near-expiry guard fires, aborts the
    // in-flight job, and leaves it pending for the node that can reclaim. maxClaims=1
    // stops this single node from re-claiming the released job and looping.
    const flaky = new FlakyRenewQueue(queue, Number.MAX_SAFE_INTEGER, 1);
    const warnings: string[] = [];
    const capturingLogger: Logger = {
      error() {},
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
    };
    const handlers: JobHandlers = {
      consolidate: async () => {
        // Run well past the lease window so the near-expiry abort must trip.
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    };
    const pool = new JobProcessorPool(flaky, handlers, {
      owner: 'node-1',
      concurrency: 1,
      leaseMs: 60,
      heartbeatMs: 10,
      pollMs: 60_000,
      logger: capturingLogger,
    });

    await queue.enqueue({ companionId: companionA, type: 'consolidate' });

    pool.nudge();
    await pool.whenIdle();

    // The near-expiry guard fired (not the authoritative `held:false` path)...
    expect(warnings.some((w) => w.includes('near expiry without renewal'))).toBe(true);
    // ...and aborted mid-run: no outcome recorded here, so the job stays pending+due
    // for whichever node reclaims the lapsed lease.
    expect(await countDuePending(db)).toBe(1);
  });
});

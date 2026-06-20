import type { JobType } from '@cobble/shared';
import type { Logger } from '../logging.js';
import {
  reactionLearnDedupeKey,
  type ClaimedCompanion,
  type EnqueueParams,
  type JobQueue,
  type QueuedJob,
} from './job-queue.js';

/**
 * Runs one job. Throwing marks the job failed (and logs); returning marks it done.
 */
export type JobHandler = (job: QueuedJob) => Promise<void>;

export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface JobProcessorOptions {
  /** This node/instance id — recorded as the claim owner (observability). */
  readonly owner: string;
  /** Max concurrent companion drains on this node (K). Sized to resource ceilings, not population. */
  readonly concurrency: number;
  /**
   * Claim lease in ms. Renewed *during* a drain by a heartbeat every
   * {@link heartbeatMs} (deliver-scalability.md §5.1.6), so it no longer has to
   * exceed the slowest job — it only bounds how long a wedged/partitioned node
   * keeps its claim before the work is reclaimed. Must exceed `heartbeatMs`.
   */
  readonly leaseMs: number;
  /**
   * Heartbeat interval in ms — how often a live drain renews its claim. A drain
   * that cannot renew for ~`leaseMs` (event-loop wedge or DB partition) loses the
   * lease, stops, and leaves its in-flight job pending for the reclaiming node.
   * Must be < `leaseMs`, with margin to survive a single missed beat.
   */
  readonly heartbeatMs: number;
  /** Coarse poll interval — the clock for idle/future-dated work. */
  readonly pollMs: number;
  readonly logger: Logger;
}

/**
 * A bounded pool of ephemeral drain loops (deliver-scalability.md §5.1). On a
 * nudge (enqueue) or poll tick, it tops up to `concurrency` loops; each claims a
 * distinct companion, drains its due jobs in order, releases, and exits when no
 * companion is claimable. The coarse poll is the clock for work that arrived with
 * no local nudge (future-dated jobs, or jobs enqueued on another node).
 */
export class JobProcessorPool {
  private readonly running = new Set<Promise<void>>();
  private readonly pendingEnqueues = new Set<Promise<void>>();
  private stopping = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly opts: JobProcessorOptions,
  ) {}

  /** Start the coarse poll and do an initial nudge. */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.nudge(), this.opts.pollMs);
    this.pollTimer.unref?.();
    this.nudge();
  }

  /** Wake the pool: top up to `concurrency` drain loops. Safe to call frequently. */
  nudge(): void {
    if (this.stopping) return;
    while (this.running.size < this.opts.concurrency) {
      const loop = this.drainLoop().finally(() => this.running.delete(loop));
      this.running.add(loop);
    }
  }

  /**
   * Enqueue a (coalesced) job and nudge the pool — fire-and-forget, but the
   * in-flight enqueue is tracked so {@link whenIdle} / {@link close} settle it
   * (deterministic test teardown; clean prod shutdown).
   */
  enqueueAndNudge(params: EnqueueParams): void {
    const p = this.queue
      .enqueue(params)
      .then(() => this.nudge())
      .catch((error: unknown) =>
        this.opts.logger.error('job enqueue failed', {
          type: params.type,
          companionId: params.companionId,
          error,
        }),
      )
      .finally(() => this.pendingEnqueues.delete(p));
    this.pendingEnqueues.add(p);
  }

  /** Resolve once all pending enqueues and in-flight drain loops have settled. */
  async whenIdle(): Promise<void> {
    while (this.pendingEnqueues.size > 0 || this.running.size > 0) {
      await Promise.allSettled([...this.pendingEnqueues, ...this.running]);
    }
  }

  /**
   * Graceful shutdown: refuse new nudges, stop polling, and let in-flight drains
   * (and pending enqueues) settle. Enqueued-but-unstarted jobs stay durable in
   * the queue and resume on the next boot's poll — so they need no draining here.
   */
  async close(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.whenIdle();
  }

  /** One ephemeral loop: claim → drain → repeat until nothing is claimable. */
  private async drainLoop(): Promise<void> {
    while (!this.stopping) {
      let claim: ClaimedCompanion | null;
      try {
        claim = await this.queue.claimNextCompanion(this.opts.owner, this.opts.leaseMs);
      } catch (error) {
        this.opts.logger.error('job claim failed', { error });
        return;
      }
      if (!claim) return;
      await this.drainCompanion(claim);
    }
  }

  private async drainCompanion(claim: ClaimedCompanion): Promise<void> {
    // One heartbeat for the whole drain: renew the claim every `heartbeatMs` so a
    // long job (or a long run of short ones) keeps the lease instead of losing it
    // to a concurrent re-claim. If a renewal reports we no longer hold the claim —
    // a multi-node reclaim after ours lapsed, or a DB partition — abort: stop
    // taking new jobs and signal the in-flight one. The lease length now bounds
    // only how long a wedged/partitioned node keeps its claim, not the slowest job.
    const lease = new AbortController();
    const heartbeat = setInterval(() => {
      void this.queue
        .renewClaim(claim.companionId, this.opts.owner, this.opts.leaseMs)
        .then((outcome) => {
          if (!outcome.held && !lease.signal.aborted) {
            this.opts.logger.warn('claim lease lost; aborting drain', {
              companionId: claim.companionId,
              owner: this.opts.owner,
              reason: outcome.reason,
              ...(outcome.heldBy !== undefined ? { reclaimedBy: outcome.heldBy } : {}),
            });
            lease.abort();
          }
        })
        .catch((error: unknown) => {
          // A renewal that errors out (e.g. DB unreachable) is treated as lost: we
          // cannot prove we still hold the claim, so stop rather than risk overlap.
          this.opts.logger.error('claim heartbeat failed', {
            companionId: claim.companionId,
            error,
          });
          if (!lease.signal.aborted) lease.abort();
        });
    }, this.opts.heartbeatMs);
    heartbeat.unref?.();
    try {
      while (!this.stopping && !lease.signal.aborted) {
        const job = await this.queue.nextDueJob(claim.companionId);
        if (!job) return;
        await this.runJob(job, lease.signal);
        // Between-jobs ownership check. The heartbeat keeps the lease alive *during*
        // a job; this catches a takeover *between* jobs synchronously, bounding the
        // overlap to the one job already in flight rather than to a heartbeat tick.
        if (lease.signal.aborted) return;
        const renewal = await this.queue.renewClaim(
          claim.companionId,
          this.opts.owner,
          this.opts.leaseMs,
        );
        if (!renewal.held) {
          this.opts.logger.info('claim moved between jobs; stopping drain', {
            companionId: claim.companionId,
            owner: this.opts.owner,
            reason: renewal.reason,
            ...(renewal.heldBy !== undefined ? { reclaimedBy: renewal.heldBy } : {}),
          });
          return;
        }
      }
    } catch (error) {
      this.opts.logger.error('companion drain failed', {
        companionId: claim.companionId,
        error,
      });
    } finally {
      clearInterval(heartbeat);
      // Owner-scoped, so it's a no-op once another node has reclaimed the lease.
      await this.queue.releaseClaim(claim.companionId, this.opts.owner).catch((error: unknown) =>
        this.opts.logger.error('claim release failed', {
          companionId: claim.companionId,
          error,
        }),
      );
    }
  }

  private async runJob(job: QueuedJob, lease: AbortSignal): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) {
      this.opts.logger.error('no handler for job type', { type: job.type, jobId: job.id });
      // Only write the terminal failure if we still hold the lease. If the lease
      // was lost, the reclaiming node now owns this job; marking it failed here
      // would race that node (the C2 finding), so leave it pending for reclaim.
      if (lease.aborted) {
        this.opts.logger.warn('job lease lost before dispatch; leaving pending for reclaim', {
          jobId: job.id,
          type: job.type,
          companionId: job.companionId,
        });
        return;
      }
      await this.queue.markFailed(job.id, `no handler for job type ${job.type}`);
      return;
    }
    let handlerError: unknown;
    try {
      await handler(job);
    } catch (error) {
      // A genuine handler failure (we still hold the lease) is terminal for this
      // pass. If instead the lease was lost mid-run, the error is moot for the
      // outcome — fall through to the shared lost-lease handling below, but keep
      // the error so it's still logged there (no silent catch).
      if (!lease.aborted) {
        this.opts.logger.error('job failed', {
          jobId: job.id,
          type: job.type,
          companionId: job.companionId,
          error,
        });
        await this.queue.markFailed(job.id, error instanceof Error ? error.message : String(error));
        return;
      }
      handlerError = error;
    }
    // Lost the lease while the job ran (handler returned OR threw): record no
    // outcome — the reclaiming node now owns this job and will run it. Marking it
    // done/failed here would race that node (the C2 finding). Leaving it pending is
    // safe — idempotent handlers re-run cleanly, and ingest's status machine fails
    // an interrupted partial for re-upload rather than duplicating it (ingest-job.ts).
    if (lease.aborted) {
      this.opts.logger.warn('job lease lost mid-run; leaving pending for reclaim', {
        jobId: job.id,
        type: job.type,
        companionId: job.companionId,
        // A handler that also threw before the lease dropped: surface its error so
        // a real bug coincident with lease loss isn't lost (the reclaiming node
        // re-runs the job, but this trace is the only record of the failed attempt).
        ...(handlerError !== undefined ? { handlerError } : {}),
      });
      return;
    }
    await this.queue.markDone(job.id);
  }
}

/** The fire-and-forget trigger interface the inline triggers + catch-up sweeps call. */
export interface CompanionWorkRequester {
  request(companionId: string): void;
  /** Drain the backing pool (enqueues + in-flight work) — for deterministic tests. */
  whenIdle(): Promise<void>;
}

/**
 * Adapt the pool to the `.request(companionId)` interface the routes and sweeps
 * already use: enqueue a coalesced job of `type` (dedupe key defaults to the
 * type) and nudge the local pool. This is the swap that turns the old in-process
 * runner trigger into a durable, fleet-coherent enqueue.
 */
export function makeCompanionWorkRequester(
  pool: JobProcessorPool,
  type: JobType,
): CompanionWorkRequester {
  return {
    request(companionId: string): void {
      pool.enqueueAndNudge({ companionId, type });
    },
    whenIdle(): Promise<void> {
      return pool.whenIdle();
    },
  };
}

/** What an ingest trigger supplies — the source + job ids and (for a fresh run)
 *  the staged-upload id holding the bytes. */
export interface IngestRequest {
  readonly companionId: string;
  readonly sourceId: string;
  readonly jobId: string;
  /** Present for a fresh upload; absent when re-requesting a deferred resume. */
  readonly uploadId?: string;
}

/** The trigger the intake routes + the `ingest_source` tool call. Owns the
 *  fleet-wide backpressure check (queue depth vs the configured cap). */
export interface IngestWorkRequester {
  /**
   * Enqueue a durable `ingest` job for one source and nudge a local worker to
   * pick it up. Coalesces on `ingest:{sourceId}` — a duplicate trigger for the
   * same source dedupes; distinct sources don't collapse. Fire-and-forget: the
   * job is durable, so any node may run it.
   */
  request(params: IngestRequest): void;
  /** True when too many ingest jobs are already pending (maps to 429 / busy). */
  isFull(): Promise<boolean>;
  /** Drain the backing pool — for deterministic tests. */
  whenIdle(): Promise<void>;
}

/**
 * Adapt the pool + queue to the ingest trigger. Each source coalesces on its own
 * `ingest:{sourceId}` key (a duplicate trigger dedupes; distinct sources don't
 * collapse). `isFull` counts pending `ingest` jobs across the fleet — the durable
 * replacement for the old in-process IngestionRunner depth cap.
 */
export function makeIngestWorkRequester(
  pool: JobProcessorPool,
  queue: JobQueue,
  maxQueueDepth: number,
): IngestWorkRequester {
  return {
    request(params: IngestRequest): void {
      pool.enqueueAndNudge({
        companionId: params.companionId,
        type: 'ingest',
        dedupeKey: `ingest:${params.sourceId}`,
        payload: {
          sourceId: params.sourceId,
          jobId: params.jobId,
          ...(params.uploadId !== undefined ? { uploadId: params.uploadId } : {}),
        },
      });
    },
    async isFull(): Promise<boolean> {
      return (await queue.pendingCountByType('ingest')) >= maxQueueDepth;
    },
    whenIdle(): Promise<void> {
      return pool.whenIdle();
    },
  };
}

/** The trigger interface the reaction route calls — per-event, so it carries the
 *  reacted message id + emoji (unlike the companion-only consolidate/motivation). */
export interface ReactionWorkRequester {
  request(companionId: string, messageId: string, emoji: string): void;
  /** Drain the backing pool — for deterministic tests. */
  whenIdle(): Promise<void>;
}

/**
 * Adapt the pool to the reaction route's trigger. Each distinct reaction
 * coalesces on its own `reaction:{messageId}:{emoji}` key (a re-tap dedupes; two
 * different reactions don't collapse), then nudges the local pool.
 */
export function makeReactionWorkRequester(pool: JobProcessorPool): ReactionWorkRequester {
  return {
    request(companionId: string, messageId: string, emoji: string): void {
      pool.enqueueAndNudge({
        companionId,
        type: 'reaction_learn',
        dedupeKey: reactionLearnDedupeKey(messageId, emoji),
        payload: { messageId, emoji },
      });
    },
    whenIdle(): Promise<void> {
      return pool.whenIdle();
    },
  };
}

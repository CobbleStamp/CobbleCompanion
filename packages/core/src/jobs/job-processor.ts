import type { JobType } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { ClaimedCompanion, JobQueue, QueuedJob } from './job-queue.js';

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
   * Claim lease in ms. Must exceed the slowest single job's runtime with margin
   * (the lease is renewed *between* jobs, not mid-job — deliver-scalability.md
   * §5.1.6). A job that outruns the lease risks a concurrent re-claim.
   */
  readonly leaseMs: number;
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

  /** Resolve once all in-flight drain loops have settled. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  /** Stop accepting work, stop polling, and drain in-flight loops. */
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
    try {
      while (!this.stopping) {
        const job = await this.queue.nextDueJob(claim.companionId);
        if (!job) return;
        await this.runJob(job);
        // Heartbeat between jobs so a long companion drain keeps its lease.
        await this.queue.renewClaim(claim.companionId, this.opts.owner, this.opts.leaseMs);
      }
    } catch (error) {
      this.opts.logger.error('companion drain failed', {
        companionId: claim.companionId,
        error,
      });
    } finally {
      await this.queue.releaseClaim(claim.companionId, this.opts.owner).catch((error: unknown) =>
        this.opts.logger.error('claim release failed', {
          companionId: claim.companionId,
          error,
        }),
      );
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) {
      this.opts.logger.error('no handler for job type', { type: job.type, jobId: job.id });
      await this.queue.markFailed(job.id, `no handler for job type ${job.type}`);
      return;
    }
    try {
      await handler(job);
      await this.queue.markDone(job.id);
    } catch (error) {
      this.opts.logger.error('job failed', {
        jobId: job.id,
        type: job.type,
        companionId: job.companionId,
        error,
      });
      await this.queue.markFailed(job.id, error instanceof Error ? error.message : String(error));
    }
  }
}

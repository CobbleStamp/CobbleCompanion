import type { JobType } from '@cobble/shared';
import { activeEmbodiment, companionClaims, type Database, jobs } from '@cobble/db';
import { and, eq, gt, lte, sql } from 'drizzle-orm';

/**
 * Queue / embodiment observability (deliver-scalability.md §C "C2"). A read-only,
 * point-in-time snapshot of the durable background machinery — the job queue
 * (`jobs`), the per-companion work lease (`companion_claims`), and the live
 * embodiment claim (`active_embodiment`). Surfaced behind the admin-only
 * `/admin/queue` route so an operator can answer "is work draining, is anything
 * starving or failing, how many companions are claimed/embodied right now?".
 *
 * Every field is derived from shared Postgres, so the snapshot is fleet-wide
 * (correct at N nodes), not this node's local view. Ages are computed in SQL
 * (`now()` is the DB clock) so there is no app↔db clock skew.
 */

/** The two signals an operator alerts on (deliver-scalability.md §C). */
export interface QueueMetricsSnapshot {
  /** Pending jobs whose `run_at` has arrived (eligible to run now). */
  readonly pendingDue: number;
  /** All pending jobs, including future-dated (backoff/deferred) work. */
  readonly pendingTotal: number;
  /** Due-pending depth broken out by job type — all four types, zero-filled. */
  readonly pendingByType: Record<JobType, number>;
  /**
   * Age of the oldest **due** pending job, in ms — the starvation canary. Null
   * when nothing is due-pending. A climbing value means workers can't keep up.
   */
  readonly oldestPendingDueAgeMs: number | null;
  /** Jobs in the terminal `failed` state (poison / unhandled). */
  readonly failedTotal: number;
  /** Failed depth broken out by job type. */
  readonly failedByType: Record<JobType, number>;
  /** Companions currently held under a live work lease (`companion_claims`). */
  readonly liveJobClaims: number;
  /**
   * Live work leases whose `generation > 1` — i.e. the claim was **reclaimed**
   * (a prior holder crashed/lapsed and another took it over) rather than freshly
   * taken. A non-zero count is the fleet-wide failover signal.
   */
  readonly reclaimedJobClaims: number;
  /** Companions with a live (non-expired) embodiment connection. */
  readonly liveEmbodiments: number;
}

export interface QueueMetricsReader {
  snapshot(): Promise<QueueMetricsSnapshot>;
}

/** A zero-filled, stable {@link QueueMetricsSnapshot} per-type map. */
function zeroByType(): Record<JobType, number> {
  return { consolidate: 0, motivation: 0, reaction_learn: 0, ingest: 0 };
}

export class DrizzleQueueMetricsReader implements QueueMetricsReader {
  /**
   * @param ttlMs Embodiment claim TTL (config.wsClaimTtlMs) — a claim with no
   *   heartbeat for longer than this is dead, so it is excluded from the live count.
   */
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
  ) {}

  async snapshot(): Promise<QueueMetricsSnapshot> {
    const pendingByTypeRows = await this.db
      .select({ type: jobs.type, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, sql`now()`)))
      .groupBy(jobs.type);

    const failedByTypeRows = await this.db
      .select({ type: jobs.type, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.status, 'failed'))
      .groupBy(jobs.type);

    // Total pending (incl. future-dated) + the oldest due-pending age, in one pass.
    const [pendingAgg] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        oldestDueAgeMs: sql<
          number | null
        >`max(case when ${jobs.runAt} <= now() then extract(epoch from (now() - ${jobs.runAt})) * 1000 end)`,
      })
      .from(jobs)
      .where(eq(jobs.status, 'pending'));

    const liveSince = sql`now() - ${this.ttlMs} * interval '1 millisecond'`;
    const [claimAgg] = await this.db
      .select({
        live: sql<number>`count(*)::int`,
        reclaimed: sql<number>`count(*) filter (where ${companionClaims.generation} > 1)::int`,
      })
      .from(companionClaims)
      .where(gt(companionClaims.claimedUntil, sql`now()`));

    const [embodimentAgg] = await this.db
      .select({ live: sql<number>`count(*)::int` })
      .from(activeEmbodiment)
      .where(sql`${activeEmbodiment.lastHeartbeat} >= ${liveSince}`);

    const pendingByType = zeroByType();
    let pendingDue = 0;
    for (const row of pendingByTypeRows) {
      pendingByType[row.type] = row.n;
      pendingDue += row.n;
    }

    const failedByType = zeroByType();
    let failedTotal = 0;
    for (const row of failedByTypeRows) {
      failedByType[row.type] = row.n;
      failedTotal += row.n;
    }

    // extract(epoch …) yields a fractional second value; round to whole ms.
    const oldestRaw = pendingAgg?.oldestDueAgeMs ?? null;
    const oldestPendingDueAgeMs = oldestRaw === null ? null : Math.round(Number(oldestRaw));

    return {
      pendingDue,
      pendingTotal: pendingAgg?.total ?? 0,
      pendingByType,
      oldestPendingDueAgeMs,
      failedTotal,
      failedByType,
      liveJobClaims: claimAgg?.live ?? 0,
      reclaimedJobClaims: claimAgg?.reclaimed ?? 0,
      liveEmbodiments: embodimentAgg?.live ?? 0,
    };
  }
}

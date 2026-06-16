import type { JobPayload, JobType } from '@cobble/shared';
import { companionClaims, type Database, jobs } from '@cobble/db';
import { and, eq, lt, lte, or, isNull, sql } from 'drizzle-orm';

/**
 * The background job queue (deliver-scalability.md §5.1, Phase B). A durable,
 * Postgres-backed replacement for the in-process runners + their coalescing
 * `Set`s. Work is claimed at **companion granularity** under a lease, so exactly
 * one processor fleet-wide touches a companion's background state at a time, and
 * duplicate setInterval sweeps across nodes can no longer run the same work N
 * times.
 *
 * Concurrency note: the claim relies on `INSERT … ON CONFLICT DO UPDATE … WHERE
 * claimed_until < now()` being atomic (only one writer can transition an
 * absent/expired claim to held). That is correct on real Postgres; the in-memory
 * PGlite used in tests is single-connection, so the *races* aren't exercised
 * there — see deliver-scalability.md §7 Q1 (known gap).
 */

/** One unit of background work, as the processor sees it. */
export interface QueuedJob {
  readonly id: string;
  readonly companionId: string;
  readonly type: JobType;
  readonly dedupeKey: string;
  readonly payload: JobPayload;
  readonly attempts: number;
}

export interface EnqueueParams {
  readonly companionId: string;
  readonly type: JobType;
  /** Type-specific reference (never bulk data). Defaults to `{}`. */
  readonly payload?: JobPayload;
  /** Earliest eligible time; defaults to now (immediate). */
  readonly runAt?: Date;
  /**
   * Coalescing key. Defaults to the bare `type` (one pending job per
   * companion+type — right for idempotent companion-wide work). Per-event work
   * (e.g. `reaction_learn`) passes a discriminated key so distinct events don't
   * collapse: see {@link reactionLearnDedupeKey}.
   */
  readonly dedupeKey?: string;
}

/** A companion successfully claimed for draining, with its fencing generation. */
export interface ClaimedCompanion {
  readonly companionId: string;
  readonly owner: string;
  readonly generation: number;
}

export interface JobQueue {
  enqueue(params: EnqueueParams): Promise<void>;
  claimNextCompanion(owner: string, leaseMs: number): Promise<ClaimedCompanion | null>;
  nextDueJob(companionId: string): Promise<QueuedJob | null>;
  markDone(jobId: string): Promise<void>;
  markFailed(jobId: string, error: string): Promise<void>;
  /** Heartbeat: extend our lease. Returns false if we no longer hold it. */
  renewClaim(companionId: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Release our claim (no-op if it has already been taken over). */
  releaseClaim(companionId: string, owner: string): Promise<void>;
  /** Count of pending jobs that are due now — observability + poll wake. */
  duePendingCount(): Promise<number>;
}

/** The dedupe key for a `reaction_learn` job — one per distinct reaction. */
export function reactionLearnDedupeKey(messageId: string, emoji: string): string {
  return `reaction:${messageId}:${emoji}`;
}

/** How many candidate companions to try claiming per `claimNextCompanion` call. */
const CLAIM_CANDIDATE_BATCH = 8;

export class DrizzleJobQueue implements JobQueue {
  constructor(private readonly db: Database) {}

  async enqueue(params: EnqueueParams): Promise<void> {
    const runAt = params.runAt ?? new Date();
    const dedupeKey = params.dedupeKey ?? params.type;
    await this.db
      .insert(jobs)
      .values({
        companionId: params.companionId,
        type: params.type,
        dedupeKey,
        payload: params.payload ?? {},
        runAt,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: [jobs.companionId, jobs.dedupeKey],
        targetWhere: sql`status = 'pending'`,
        // Collapse onto the existing pending row, keeping the earliest run_at so a
        // sooner trigger isn't delayed by an earlier-scheduled one.
        set: {
          runAt: sql`least(${jobs.runAt}, ${runAt}::timestamptz)`,
          payload: params.payload ?? {},
          updatedAt: sql`now()`,
        },
      });
  }

  async claimNextCompanion(owner: string, leaseMs: number): Promise<ClaimedCompanion | null> {
    // Candidates: companions with due, pending work and no live claim. Ordered by
    // their oldest due job so the most-overdue work is picked up first.
    const candidates = await this.db
      .select({ companionId: jobs.companionId })
      .from(jobs)
      .leftJoin(companionClaims, eq(companionClaims.companionId, jobs.companionId))
      .where(
        and(
          eq(jobs.status, 'pending'),
          lte(jobs.runAt, sql`now()`),
          or(isNull(companionClaims.companionId), lt(companionClaims.claimedUntil, sql`now()`)),
        ),
      )
      .groupBy(jobs.companionId)
      .orderBy(sql`min(${jobs.runAt})`)
      .limit(CLAIM_CANDIDATE_BATCH);

    for (const { companionId } of candidates) {
      const generation = await this.tryClaim(companionId, owner, leaseMs);
      if (generation !== null) {
        return { companionId, owner, generation };
      }
    }
    return null;
  }

  /**
   * Atomically claim one companion. The conditional `ON CONFLICT DO UPDATE …
   * WHERE claimed_until < now()` is the exclusivity gate: a fresh insert wins, an
   * expired claim is taken over, and a live claim yields zero rows (someone else
   * holds it). Returns the new generation, or null if not claimable.
   */
  private async tryClaim(
    companionId: string,
    owner: string,
    leaseMs: number,
  ): Promise<number | null> {
    const until = sql`now() + ${leaseMs} * interval '1 millisecond'`;
    const rows = await this.db
      .insert(companionClaims)
      .values({ companionId, owner, generation: 1, claimedUntil: until })
      .onConflictDoUpdate({
        target: companionClaims.companionId,
        set: {
          owner,
          generation: sql`${companionClaims.generation} + 1`,
          claimedUntil: until,
          updatedAt: sql`now()`,
        },
        setWhere: lt(companionClaims.claimedUntil, sql`now()`),
      })
      .returning({ generation: companionClaims.generation });
    return rows[0]?.generation ?? null;
  }

  async nextDueJob(companionId: string): Promise<QueuedJob | null> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.companionId, companionId),
          eq(jobs.status, 'pending'),
          lte(jobs.runAt, sql`now()`),
        ),
      )
      .orderBy(jobs.runAt, jobs.createdAt)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      companionId: row.companionId,
      type: row.type,
      dedupeKey: row.dedupeKey,
      payload: row.payload,
      attempts: row.attempts,
    };
  }

  async markDone(jobId: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'done', updatedAt: sql`now()` })
      .where(eq(jobs.id, jobId));
  }

  async markFailed(jobId: string, error: string): Promise<void> {
    // Terminal for Phase B: a failed background pass simply waits for its next
    // trigger to re-enqueue (the old runners logged-and-moved-on too). `attempts`
    // + `lastError` are kept for observability; retry/backoff is a later tunable
    // (deliver-scalability.md §5.1.6).
    await this.db
      .update(jobs)
      .set({
        status: 'failed',
        lastError: error.slice(0, 2000),
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId));
  }

  async renewClaim(companionId: string, owner: string, leaseMs: number): Promise<boolean> {
    const rows = await this.db
      .update(companionClaims)
      .set({
        claimedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(companionClaims.companionId, companionId),
          eq(companionClaims.owner, owner),
          // Only if we still hold a live claim — if it lapsed and another node
          // took over, do not stomp their claim.
          sql`${companionClaims.claimedUntil} >= now()`,
        ),
      )
      .returning({ companionId: companionClaims.companionId });
    return rows.length > 0;
  }

  async releaseClaim(companionId: string, owner: string): Promise<void> {
    await this.db
      .delete(companionClaims)
      .where(and(eq(companionClaims.companionId, companionId), eq(companionClaims.owner, owner)));
  }

  async duePendingCount(): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, sql`now()`)));
    return rows[0]?.n ?? 0;
  }
}

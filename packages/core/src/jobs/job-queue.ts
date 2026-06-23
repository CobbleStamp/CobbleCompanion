import type { JobPayload, JobType } from '@cobble/shared';
import { companionClaims, type Database, jobs } from '@cobble/db';
import { and, eq, exists, lt, lte, or, isNull, sql } from 'drizzle-orm';
import type { Logger } from '../logging.js';

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
 * PGlite used in the unit suite is single-connection, so the *races* are
 * exercised separately against real Postgres in `job-queue.integration.test.ts`
 * (run via `make test-integration` — deliver-scalability.md §7 Q1).
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

/**
 * The result of a heartbeat renewal. `held: true` means we still own the claim; a
 * failure carries *why* we lost it so the caller can log a precise reason rather
 * than a bare boolean (typescript/coding-style.md — model recoverable failures as
 * a tagged Result; logging.md — log failures with context).
 */
export type RenewOutcome =
  | { readonly held: true }
  | {
      readonly held: false;
      /**
       * `reclaimed`: a different owner holds it now (their id is `heldBy`).
       * `lapsed`: still ours, but `claimed_until` is in the past (we fell behind).
       * `released`: the claim row is gone entirely.
       */
      readonly reason: 'reclaimed' | 'lapsed' | 'released';
      readonly heldBy?: string;
    };

export interface JobQueue {
  enqueue(params: EnqueueParams): Promise<void>;
  claimNextCompanion(owner: string, leaseMs: number): Promise<ClaimedCompanion | null>;
  nextDueJob(companionId: string): Promise<QueuedJob | null>;
  /**
   * Record a job's terminal outcome, **fenced on the claim under which it ran**.
   * The write lands only while `companion_claims` still shows the drain's
   * `(owner, generation)` — so a stale drain whose lease lapsed and was reclaimed
   * mid-write matches zero rows and cannot stomp the reclaiming node's outcome
   * (the C1 race; the in-process `lease.aborted` check is a best-effort early-out,
   * this is the authoritative DB fence). `generation` is the ABA-safe token: every
   * reclaim bumps it, so a write from a superseded epoch always fails the predicate.
   * Returns `true` if the row was written, `false` if it was fenced out.
   */
  markDone(jobId: string, claim: ClaimedCompanion): Promise<boolean>;
  markFailed(jobId: string, error: string, claim: ClaimedCompanion): Promise<boolean>;
  /** Heartbeat: extend our lease. On failure, returns why we no longer hold it. */
  renewClaim(companionId: string, owner: string, leaseMs: number): Promise<RenewOutcome>;
  /** Release our claim (no-op if it has already been taken over). */
  releaseClaim(companionId: string, owner: string): Promise<void>;
  /** Count of pending jobs of a type (any run_at) — fleet-wide backpressure (ingest). */
  pendingCountByType(type: JobType): Promise<number>;
}

/** The dedupe key for a `reaction_learn` job — one per distinct reaction. */
export function reactionLearnDedupeKey(messageId: string, emoji: string): string {
  return `reaction:${messageId}:${emoji}`;
}

/** How many candidate companions to try claiming per `claimNextCompanion` call. */
const CLAIM_CANDIDATE_BATCH = 8;

export class DrizzleJobQueue implements JobQueue {
  /**
   * @param logger Optional — when present, a **reclaim** (takeover of a
   *   crashed/lapsed holder's claim) is logged for C2 observability
   *   (deliver-scalability.md §C). Omitted in tests that don't assert on it.
   */
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

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
    const generation = rows[0]?.generation ?? null;
    // generation > 1 means the row pre-existed and was taken over via the
    // `setWhere claimed_until < now()` gate — a crashed/lapsed holder's claim was
    // reclaimed (a fresh claim after a clean release deletes the row, so a re-claim
    // is generation 1 again). Surface the failover for C2 (the reclaim-count signal).
    if (generation !== null && generation > 1) {
      this.logger?.warn('job claim reclaimed', { companionId, owner, generation });
    }
    return generation;
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

  /**
   * The fencing predicate: the companion's claim row still belongs to the drain's
   * `(owner, generation)`. A reclaim bumps `generation` (tryClaim does `+ 1`), so a
   * superseded epoch fails to match — ABA-safe even if the same node id reclaims
   * later. Liveness (`claimed_until >= now()`) is deliberately NOT required: while a
   * lease has lapsed but nobody has reclaimed, `generation` is unchanged and this
   * drain's completed work is the only outcome — landing it avoids needlessly
   * discarding work, and any reclaim would have bumped `generation` and rejected us.
   */
  private claimStillHeld(claim: ClaimedCompanion) {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(companionClaims)
        .where(
          and(
            eq(companionClaims.companionId, claim.companionId),
            eq(companionClaims.owner, claim.owner),
            eq(companionClaims.generation, claim.generation),
          ),
        ),
    );
  }

  async markDone(jobId: string, claim: ClaimedCompanion): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'done', updatedAt: sql`now()` })
      .where(and(eq(jobs.id, jobId), this.claimStillHeld(claim)))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async markFailed(jobId: string, error: string, claim: ClaimedCompanion): Promise<boolean> {
    // Terminal for Phase B: a failed background pass simply waits for its next
    // trigger to re-enqueue (the old runners logged-and-moved-on too). `attempts`
    // + `lastError` are kept for observability; retry/backoff is a later tunable
    // (deliver-scalability.md §5.1.6). Fenced on the claim (see {@link claimStillHeld}).
    const rows = await this.db
      .update(jobs)
      .set({
        status: 'failed',
        lastError: error.slice(0, 2000),
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, jobId), this.claimStillHeld(claim)))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async renewClaim(companionId: string, owner: string, leaseMs: number): Promise<RenewOutcome> {
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
    if (rows.length > 0) {
      return { held: true };
    }
    // The renewal matched no row — diagnose why, so the caller logs a precise
    // reason. Read-only and only on the (rare) failure path, so the extra
    // round-trip is never on the hot path.
    const [current] = await this.db
      .select({ owner: companionClaims.owner, claimedUntil: companionClaims.claimedUntil })
      .from(companionClaims)
      .where(eq(companionClaims.companionId, companionId));
    if (!current) {
      return { held: false, reason: 'released' };
    }
    if (current.owner !== owner) {
      return { held: false, reason: 'reclaimed', heldBy: current.owner };
    }
    return { held: false, reason: 'lapsed' };
  }

  async releaseClaim(companionId: string, owner: string): Promise<void> {
    await this.db
      .delete(companionClaims)
      .where(and(eq(companionClaims.companionId, companionId), eq(companionClaims.owner, owner)));
  }

  async pendingCountByType(type: JobType): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), eq(jobs.type, type)));
    return rows[0]?.n ?? 0;
  }
}

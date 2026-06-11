/**
 * Reinforcement record store (Phase 4) — one `proactive_outcomes` row per
 * initiation: the engine records it when it acts (the report note + served drive
 * + weight snapshot); the reward is filled in when the user reacts to that note
 * in conversation (Phase 4.2 — the *change* in their mood across the reaction,
 * not approve/reject). Also the helpful-vs-annoying measurement surface.
 */

import { messages, proactiveOutcomes, userFacts, type Database } from '@cobble/db';
import type { Drive, DriveWeights } from '@cobble/shared';
import { and, count, desc, eq, isNull, lt, sql } from 'drizzle-orm';

export interface RecordOutcomeInput {
  /** The drive the move served (whose weight a reward nudges). */
  readonly drive: Drive;
  /** Weights at initiation, for attribution. */
  readonly driveSnapshot?: DriveWeights;
  /**
   * The report note the user will react to — the reward-attribution target
   * (Phase 4.1). The user's next conversational reaction scores this outcome.
   */
  readonly noteMessageId?: string;
  /** Legacy (pre-4.1): the proposal this initiation produced, if any. */
  readonly proposalId?: string;
  /**
   * The Tier-2 belief that drove this burst (Phase 12 belief-learning loop). When set,
   * the reaction reward also adjusts that belief's salience (reinforce.ts). Null for a
   * non-belief-driven burst.
   */
  readonly drivenByUserFactId?: string;
}

export interface ProactiveOutcomeRecord {
  readonly id: string;
  readonly companionId: string;
  readonly noteMessageId: string | null;
  readonly proposalId: string | null;
  readonly drive: Drive;
  readonly drivenByUserFactId: string | null;
  readonly reward: number | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/**
 * Aggregate initiative signal for the growth Initiative axis (mirror reading):
 * `total` initiations the companion has made on its own, and how many of those
 * drew a `positive` reaction (a welcomed reaction, mood delta > 0). Derived,
 * never stored.
 */
export interface ProactiveOutcomeStats {
  readonly total: number;
  readonly positive: number;
}

/** The Tier-2 belief that drove a burst, joined for the activity log. */
export interface ProactiveOutcomeBelief {
  readonly subject: string;
  readonly predicate: string | null;
  readonly object: string;
}

/**
 * An outcome enriched for the activity view: the bare record plus its `seq` (the
 * pagination cursor), the `driveSnapshot` weight mix, the joined report-note text
 * (`noteContent`), and the `belief` that drove it. Read-only detail surface — never
 * used on the reward-attribution path.
 */
export interface ProactiveOutcomeDetail extends ProactiveOutcomeRecord {
  readonly seq: number;
  readonly driveSnapshot: DriveWeights | null;
  readonly noteContent: string | null;
  readonly belief: ProactiveOutcomeBelief | null;
}

export interface ProactiveOutcomeStore {
  /** Record a fresh initiation (reward pending). */
  record(companionId: string, input: RecordOutcomeInput): Promise<ProactiveOutcomeRecord>;
  /** Aggregate initiative counts for the growth Initiative axis. */
  stats(companionId: string): Promise<ProactiveOutcomeStats>;
  /**
   * The most recent outcome still awaiting a reward (reward is null), if any —
   * the target the next user reaction is attributed to (Phase 4.1). Newest first.
   */
  findLatestUnresolved(companionId: string): Promise<ProactiveOutcomeRecord | null>;
  /**
   * Atomically claim an unresolved outcome and fill in its reward (companion-
   * scoped). Returns `true` iff THIS call claimed it — the update is conditioned on
   * `reward IS NULL`, so when two reactions race only one wins and only that caller
   * should go on to move personality weights. A no-op (already resolved, or wrong
   * companion) returns `false`.
   */
  setReward(companionId: string, id: string, reward: number): Promise<boolean>;
  /** Recent outcomes, newest-first (measurement + tests). */
  list(companionId: string, limit: number): Promise<readonly ProactiveOutcomeRecord[]>;
  /**
   * Recent outcomes enriched with the joined report note + driving belief, newest-
   * first, for the read-only Activity view. Keyset-paginated: pass the last page's
   * smallest `seq` as `beforeSeq` to fetch the next page.
   */
  listDetailed(
    companionId: string,
    limit: number,
    beforeSeq?: number,
  ): Promise<readonly ProactiveOutcomeDetail[]>;
}

export class DrizzleProactiveOutcomeStore implements ProactiveOutcomeStore {
  constructor(private readonly db: Database) {}

  async record(companionId: string, input: RecordOutcomeInput): Promise<ProactiveOutcomeRecord> {
    const [row] = await this.db
      .insert(proactiveOutcomes)
      .values({
        companionId,
        drive: input.drive,
        ...(input.noteMessageId !== undefined ? { noteMessageId: input.noteMessageId } : {}),
        ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
        ...(input.driveSnapshot !== undefined ? { driveSnapshot: input.driveSnapshot } : {}),
        ...(input.drivenByUserFactId !== undefined
          ? { drivenByUserFactId: input.drivenByUserFactId }
          : {}),
      })
      .returning();
    if (!row) {
      throw new Error('failed to record proactive outcome');
    }
    return toRecord(row);
  }

  async stats(companionId: string): Promise<ProactiveOutcomeStats> {
    const [row] = await this.db
      .select({
        total: count(),
        positive: sql<number>`cast(count(*) filter (where ${proactiveOutcomes.reward} > 0) as int)`,
      })
      .from(proactiveOutcomes)
      .where(eq(proactiveOutcomes.companionId, companionId));
    return {
      total: Number(row?.total ?? 0),
      positive: Number(row?.positive ?? 0),
    };
  }

  async findLatestUnresolved(companionId: string): Promise<ProactiveOutcomeRecord | null> {
    const [row] = await this.db
      .select()
      .from(proactiveOutcomes)
      .where(and(eq(proactiveOutcomes.companionId, companionId), isNull(proactiveOutcomes.reward)))
      .orderBy(desc(proactiveOutcomes.seq))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async setReward(companionId: string, id: string, reward: number): Promise<boolean> {
    // Guard on `reward IS NULL`: the update only matches an outcome no one has
    // scored yet, so concurrent reactions can't both claim it. `returning` reports
    // whether a row actually changed — the caller uses it to decide whether to nudge.
    const claimed = await this.db
      .update(proactiveOutcomes)
      .set({ reward, resolvedAt: new Date() })
      .where(
        and(
          eq(proactiveOutcomes.companionId, companionId),
          eq(proactiveOutcomes.id, id),
          isNull(proactiveOutcomes.reward),
        ),
      )
      .returning({ id: proactiveOutcomes.id });
    return claimed.length > 0;
  }

  async list(companionId: string, limit: number): Promise<readonly ProactiveOutcomeRecord[]> {
    const rows = await this.db
      .select()
      .from(proactiveOutcomes)
      .where(eq(proactiveOutcomes.companionId, companionId))
      .orderBy(desc(proactiveOutcomes.seq))
      .limit(limit);
    return rows.map(toRecord);
  }

  async listDetailed(
    companionId: string,
    limit: number,
    beforeSeq?: number,
  ): Promise<readonly ProactiveOutcomeDetail[]> {
    // LEFT JOINs so an outcome whose note was removed (`set null`) or that was not
    // belief-driven still lists — the joined columns just come back null.
    const scope = eq(proactiveOutcomes.companionId, companionId);
    const where =
      beforeSeq !== undefined ? and(scope, lt(proactiveOutcomes.seq, beforeSeq)) : scope;
    const rows = await this.db
      .select({
        id: proactiveOutcomes.id,
        seq: proactiveOutcomes.seq,
        companionId: proactiveOutcomes.companionId,
        noteMessageId: proactiveOutcomes.noteMessageId,
        proposalId: proactiveOutcomes.proposalId,
        drive: proactiveOutcomes.drive,
        driveSnapshot: proactiveOutcomes.driveSnapshot,
        drivenByUserFactId: proactiveOutcomes.drivenByUserFactId,
        reward: proactiveOutcomes.reward,
        createdAt: proactiveOutcomes.createdAt,
        resolvedAt: proactiveOutcomes.resolvedAt,
        noteContent: messages.content,
        beliefSubject: userFacts.subject,
        beliefPredicate: userFacts.predicate,
        beliefObject: userFacts.object,
      })
      .from(proactiveOutcomes)
      .leftJoin(messages, eq(proactiveOutcomes.noteMessageId, messages.id))
      .leftJoin(userFacts, eq(proactiveOutcomes.drivenByUserFactId, userFacts.id))
      .where(where)
      .orderBy(desc(proactiveOutcomes.seq))
      .limit(limit);
    return rows.map(toDetail);
  }
}

type Row = typeof proactiveOutcomes.$inferSelect;

function toRecord(row: Row): ProactiveOutcomeRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    noteMessageId: row.noteMessageId,
    proposalId: row.proposalId,
    drive: row.drive,
    drivenByUserFactId: row.drivenByUserFactId,
    reward: row.reward,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

interface DetailRow extends Row {
  readonly noteContent: string | null;
  readonly beliefSubject: string | null;
  readonly beliefPredicate: string | null;
  readonly beliefObject: string | null;
}

function toDetail(row: DetailRow): ProactiveOutcomeDetail {
  // A belief is present only when the join matched (subject + object are NOT NULL on
  // user_facts, so either both are set or the row was non-belief-driven / nulled).
  const belief: ProactiveOutcomeBelief | null =
    row.beliefSubject !== null && row.beliefObject !== null
      ? {
          subject: row.beliefSubject,
          predicate: row.beliefPredicate,
          object: row.beliefObject,
        }
      : null;
  return {
    ...toRecord(row),
    seq: row.seq,
    driveSnapshot: row.driveSnapshot ?? null,
    noteContent: row.noteContent,
    belief,
  };
}

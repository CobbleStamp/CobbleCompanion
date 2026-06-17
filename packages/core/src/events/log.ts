/**
 * The durable per-companion live-event log (deliver-scalability.md §5.2/§6 D4). The
 * cross-node delivery substrate: every publish point appends here, and the one live
 * embodiment connection's node reads rows past its cursor on each heartbeat. Unlike
 * the in-process bus, a row written on any node is visible to every node (shared
 * Postgres), so there is no fan-out to miss.
 */

import { companionEvents, type Database } from '@cobble/db';
import type { CompanionStreamEvent } from '@cobble/shared';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

/** A logged event with its monotonic cursor. */
export interface LoggedEvent {
  readonly seq: number;
  readonly event: CompanionStreamEvent;
}

export interface CompanionEventLog {
  append(companionId: string, event: CompanionStreamEvent): Promise<void>;
  /**
   * Settled events with `seq > afterSeq`, oldest-first, bounded by `limit`. "Settled"
   * = past the visibility horizon (see {@link DrizzleCompanionEventLog}), so the
   * caller can advance its cursor to the max returned seq without ever skipping a
   * late-committing lower seq.
   */
  readSince(companionId: string, afterSeq: number, limit: number): Promise<readonly LoggedEvent[]>;
  /**
   * The newest **settled** seq (0 if none) — a connection's initial cursor. Uses the
   * horizon (not the raw max seq) so an event that is in-flight at connect isn't
   * stranded between the client's transcript snapshot and live delivery.
   */
  latestSettledSeq(companionId: string): Promise<number>;
  /** The raw newest seq for a companion (0 if none), ignoring the horizon. */
  latestSeq(companionId: string): Promise<number>;
}

export class DrizzleCompanionEventLog implements CompanionEventLog {
  constructor(private readonly db: Database) {}

  /**
   * The live-delivery visibility horizon. `companion_events.seq` is a `bigserial`
   * assigned at INSERT, but rows become visible at COMMIT and commits can land out of
   * `seq` order — so a naive `seq > cursor` read can leap past a lower seq that
   * commits late and drop it permanently (deliver-scalability.md §C "C1"). A row is
   * only safe to deliver once its inserting transaction (`xid`) is below the oldest
   * still-running transaction (`pg_snapshot_xmin`): then no in-flight transaction can
   * still hold a smaller seq. Correct because every append is a single-statement
   * autocommit insert, so `xid` order matches `seq` order; the worst case is a brief
   * delivery delay (until a long-running writer commits), never a lost event.
   */
  private settled(): ReturnType<typeof sql> {
    return sql`${companionEvents.xid} < pg_snapshot_xmin(pg_current_snapshot())`;
  }

  async append(companionId: string, event: CompanionStreamEvent): Promise<void> {
    await this.db.insert(companionEvents).values({ companionId, event });
  }

  async readSince(
    companionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly LoggedEvent[]> {
    const rows = await this.db
      .select({ seq: companionEvents.seq, event: companionEvents.event })
      .from(companionEvents)
      .where(
        and(
          eq(companionEvents.companionId, companionId),
          gt(companionEvents.seq, afterSeq),
          this.settled(),
        ),
      )
      .orderBy(companionEvents.seq)
      .limit(limit);
    return rows.map((row) => ({ seq: row.seq, event: row.event }));
  }

  async latestSettledSeq(companionId: string): Promise<number> {
    const rows = await this.db
      .select({ seq: companionEvents.seq })
      .from(companionEvents)
      .where(and(eq(companionEvents.companionId, companionId), this.settled()))
      .orderBy(desc(companionEvents.seq))
      .limit(1);
    return rows[0]?.seq ?? 0;
  }

  async latestSeq(companionId: string): Promise<number> {
    const rows = await this.db
      .select({ seq: companionEvents.seq })
      .from(companionEvents)
      .where(eq(companionEvents.companionId, companionId))
      .orderBy(desc(companionEvents.seq))
      .limit(1);
    return rows[0]?.seq ?? 0;
  }
}

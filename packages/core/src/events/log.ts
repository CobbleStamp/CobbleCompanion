/**
 * The durable per-companion live-event log (deliver-scalability.md §5.2/§6 D4). The
 * cross-node delivery substrate: every publish point appends here, and the one live
 * embodiment connection's node reads rows past its cursor on each heartbeat. Unlike
 * the in-process bus, a row written on any node is visible to every node (shared
 * Postgres), so there is no fan-out to miss.
 */

import { companionEvents, type Database } from '@cobble/db';
import type { CompanionStreamEvent } from '@cobble/shared';
import { and, desc, eq, gt } from 'drizzle-orm';

/** A logged event with its monotonic cursor. */
export interface LoggedEvent {
  readonly seq: number;
  readonly event: CompanionStreamEvent;
}

export interface CompanionEventLog {
  append(companionId: string, event: CompanionStreamEvent): Promise<void>;
  /** Events with `seq > afterSeq`, oldest-first, bounded by `limit`. */
  readSince(companionId: string, afterSeq: number, limit: number): Promise<readonly LoggedEvent[]>;
  /** The newest seq for a companion (0 if none) — a connection's initial cursor. */
  latestSeq(companionId: string): Promise<number>;
}

export class DrizzleCompanionEventLog implements CompanionEventLog {
  constructor(private readonly db: Database) {}

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
      .where(and(eq(companionEvents.companionId, companionId), gt(companionEvents.seq, afterSeq)))
      .orderBy(companionEvents.seq)
      .limit(limit);
    return rows.map((row) => ({ seq: row.seq, event: row.event }));
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

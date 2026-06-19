/**
 * The live embodiment claim (deliver-scalability.md §5.2, Phase D D2). Exactly one
 * WS connection holds a companion at a time. The holder is identified by the
 * connection's ULID (`connectionId`, sortable so "newer wins" is a lexical compare);
 * a new connection force-claims and the prior holder self-fences when its heartbeat
 * renew finds it no longer owns the row. `last_heartbeat` + a TTL is the crash
 * backstop. Distinct from the job-queue companion claim and from atomic writes (Q4)
 * — its own row, its own semantics.
 */

import { activeEmbodiment, type Database } from '@cobble/db';
import { and, eq, sql } from 'drizzle-orm';

export interface EmbodimentClaim {
  readonly companionId: string;
  readonly connectionId: string;
  readonly claimSeq: number;
}

export interface ClaimParams {
  readonly companionId: string;
  /** The connection's ULID (sortable; newer wins). */
  readonly connectionId: string;
  /** Host/pid of the node holding the connection (observability). */
  readonly node: string;
  /** A held claim older than this (no heartbeat) is treated as dead and reclaimable. */
  readonly ttlMs: number;
}

export interface EmbodimentStore {
  /**
   * Force-claim a companion for a connection. Wins if there is no holder, the
   * current holder's ULID is older (newer connection wins), or the current
   * holder's claim has lapsed past the TTL (crash backstop). Returns the claim, or
   * null if a newer/live holder already exists.
   */
  claim(params: ClaimParams): Promise<EmbodimentClaim | null>;
  /**
   * Heartbeat: refresh `last_heartbeat` if this *exact* claim is still the holder.
   * Matches on `connectionId` AND the DB-stamped `claimSeq` — same fence as
   * {@link holds} — so a superseded connection self-fences even in the ABA case
   * where a ULID `connectionId` recurs (the recurred claim's seq won't match the
   * stale binding's). False = superseded.
   */
  renew(companionId: string, connectionId: string, claimSeq: number): Promise<boolean>;
  /**
   * Fencing check: is this *exact* claim still the holder? Matches on `connectionId`
   * AND the DB-stamped `claimSeq`, so a superseded connection is fenced out even in
   * the ABA case where a ULID `connectionId` value recurs across nodes/restarts — the
   * claim seq (monotonic per claim) won't match the stale binding's.
   */
  holds(companionId: string, connectionId: string, claimSeq: number): Promise<boolean>;
  /** Release on clean disconnect — only if this connection is still the holder
   *  (never stomps a successor). */
  release(companionId: string, connectionId: string): Promise<void>;
  /** The current live (non-expired) claim, or null — used by presence (D5) + tests. */
  current(companionId: string, ttlMs: number): Promise<EmbodimentClaim | null>;
}

export class DrizzleEmbodimentStore implements EmbodimentStore {
  constructor(private readonly db: Database) {}

  async claim(params: ClaimParams): Promise<EmbodimentClaim | null> {
    const deadBefore = sql`now() - ${params.ttlMs} * interval '1 millisecond'`;
    const rows = await this.db
      .insert(activeEmbodiment)
      .values({
        companionId: params.companionId,
        connectionId: params.connectionId,
        node: params.node,
        claimSeq: 1,
        lastHeartbeat: sql`now()`,
      })
      .onConflictDoUpdate({
        target: activeEmbodiment.companionId,
        set: {
          connectionId: params.connectionId,
          node: params.node,
          claimSeq: sql`${activeEmbodiment.claimSeq} + 1`,
          lastHeartbeat: sql`now()`,
          // A new connection takes the room present + foregrounded (D5 presence).
          lastActivityAt: sql`now()`,
          tabVisible: true,
          updatedAt: sql`now()`,
        },
        // Take over only from an older ULID (newer connection wins) or a holder
        // whose heartbeat has lapsed (dead). A live, newer-or-equal holder keeps it.
        setWhere: sql`${activeEmbodiment.connectionId} < ${params.connectionId} OR ${activeEmbodiment.lastHeartbeat} < ${deadBefore}`,
      })
      .returning({
        connectionId: activeEmbodiment.connectionId,
        claimSeq: activeEmbodiment.claimSeq,
      });
    const row = rows[0];
    return row
      ? {
          companionId: params.companionId,
          connectionId: row.connectionId,
          claimSeq: row.claimSeq,
        }
      : null;
  }

  async renew(companionId: string, connectionId: string, claimSeq: number): Promise<boolean> {
    const rows = await this.db
      .update(activeEmbodiment)
      .set({ lastHeartbeat: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(activeEmbodiment.companionId, companionId),
          eq(activeEmbodiment.connectionId, connectionId),
          eq(activeEmbodiment.claimSeq, claimSeq),
        ),
      )
      .returning({ companionId: activeEmbodiment.companionId });
    return rows.length > 0;
  }

  async holds(companionId: string, connectionId: string, claimSeq: number): Promise<boolean> {
    const rows = await this.db
      .select({ companionId: activeEmbodiment.companionId })
      .from(activeEmbodiment)
      .where(
        and(
          eq(activeEmbodiment.companionId, companionId),
          eq(activeEmbodiment.connectionId, connectionId),
          eq(activeEmbodiment.claimSeq, claimSeq),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async release(companionId: string, connectionId: string): Promise<void> {
    await this.db
      .delete(activeEmbodiment)
      .where(
        and(
          eq(activeEmbodiment.companionId, companionId),
          eq(activeEmbodiment.connectionId, connectionId),
        ),
      );
  }

  async current(companionId: string, ttlMs: number): Promise<EmbodimentClaim | null> {
    const liveSince = sql`now() - ${ttlMs} * interval '1 millisecond'`;
    const rows = await this.db
      .select({
        connectionId: activeEmbodiment.connectionId,
        claimSeq: activeEmbodiment.claimSeq,
      })
      .from(activeEmbodiment)
      .where(
        and(
          eq(activeEmbodiment.companionId, companionId),
          sql`${activeEmbodiment.lastHeartbeat} >= ${liveSince}`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { companionId, connectionId: row.connectionId, claimSeq: row.claimSeq } : null;
  }
}

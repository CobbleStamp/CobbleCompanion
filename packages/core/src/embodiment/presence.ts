/**
 * Presence derived from the live embodiment claim (deliver-scalability.md §6 D5).
 * The `active_embodiment` row IS the presence signal: a live claim (heartbeat within
 * the TTL) means the user is embodying the companion now. This replaces the per-node
 * in-memory presence store, so a turn on one node and a motivation tick on another
 * see the same presence — and a dropped connection naturally becomes "absent" when
 * its claim lapses. Writes are best-effort/fire-and-forget (presence is volatile)
 * and fenced on the full claim key (connectionId + claimSeq), so a write that
 * loses the claim mid-flight self-fences rather than stomping the successor.
 */

import { activeEmbodiment, type Database } from '@cobble/db';
import { and, eq, sql } from 'drizzle-orm';
import { consoleLogger, type Logger } from '../logging.js';
import type { PresenceSignal } from '../motivation/presence.js';
import type { PresenceFence, PresenceStore } from '../motivation/presence-store.js';

export class EmbodimentPresenceStore implements PresenceStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
    private readonly logger: Logger = consoleLogger,
  ) {}

  recordHeartbeat(companionId: string, opts: { tabVisible: boolean; fence: PresenceFence }): void {
    // The claim's `last_heartbeat` is renewed by the connection's heartbeat loop;
    // a heartbeat only refreshes visibility here (not activity).
    this.fireUpdate(companionId, opts.fence, { tabVisible: opts.tabVisible });
  }

  recordActivity(companionId: string, fence: PresenceFence): void {
    // Real activity (a turn) bumps last_activity_at and implies the room is in front.
    this.fireUpdate(companionId, fence, { lastActivityAt: sql`now()`, tabVisible: true });
  }

  async get(companionId: string): Promise<PresenceSignal | null> {
    const liveSince = sql`now() - ${this.ttlMs} * interval '1 millisecond'`;
    const rows = await this.db
      .select({
        lastActivityAt: activeEmbodiment.lastActivityAt,
        lastHeartbeatAt: activeEmbodiment.lastHeartbeat,
        tabVisible: activeEmbodiment.tabVisible,
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
    if (!row) {
      return null; // no live claim → absent
    }
    return {
      lastActivityAt: row.lastActivityAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      tabVisible: row.tabVisible,
    };
  }

  private fireUpdate(
    companionId: string,
    fence: PresenceFence,
    patch: { lastActivityAt?: ReturnType<typeof sql>; tabVisible?: boolean },
  ): void {
    // Fence the write on the full claim key (connectionId + claimSeq), not just
    // companionId — the same fence `renew`/`holds` use. The caller already passed
    // the dispatcher's `holds()` check, but that check and this write are not
    // atomic: if a newer connection force-claims the room in between, an unfenced
    // by-companionId write would stomp the successor's freshly-claimed
    // tabVisible/lastActivityAt. Scoping the WHERE makes a superseded write a
    // self-fencing no-op (presence is volatile — the live holder's next beat
    // re-establishes the signal).
    void this.db
      .update(activeEmbodiment)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(activeEmbodiment.companionId, companionId),
          eq(activeEmbodiment.connectionId, fence.connectionId),
          eq(activeEmbodiment.claimSeq, fence.claimSeq),
        ),
      )
      .catch((error: unknown) =>
        this.logger.error('failed to record presence on the embodiment claim', {
          operation: 'embodiment.presence',
          companionId,
          error,
        }),
      );
  }
}

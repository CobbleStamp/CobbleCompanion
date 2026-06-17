/**
 * Presence derived from the live embodiment claim (deliver-scalability.md §6 D5).
 * The `active_embodiment` row IS the presence signal: a live claim (heartbeat within
 * the TTL) means the user is embodying the companion now. This replaces the per-node
 * in-memory presence store, so a turn on one node and a motivation tick on another
 * see the same presence — and a dropped connection naturally becomes "absent" when
 * its claim lapses. Writes are best-effort/fire-and-forget (presence is volatile).
 */

import { activeEmbodiment, type Database } from '@cobble/db';
import { and, eq, sql } from 'drizzle-orm';
import { consoleLogger, type Logger } from '../logging.js';
import type { PresenceSignal } from '../motivation/presence.js';
import type { PresenceStore } from '../motivation/presence-store.js';

export class EmbodimentPresenceStore implements PresenceStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
    private readonly logger: Logger = consoleLogger,
  ) {}

  recordHeartbeat(companionId: string, opts: { tabVisible: boolean }): void {
    // The claim's `last_heartbeat` is renewed by the connection's heartbeat loop;
    // a heartbeat only refreshes visibility here (not activity).
    this.fireUpdate(companionId, { tabVisible: opts.tabVisible });
  }

  recordActivity(companionId: string): void {
    // Real activity (a turn) bumps last_activity_at and implies the room is in front.
    this.fireUpdate(companionId, { lastActivityAt: sql`now()`, tabVisible: true });
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
    patch: { lastActivityAt?: ReturnType<typeof sql>; tabVisible?: boolean },
  ): void {
    void this.db
      .update(activeEmbodiment)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(activeEmbodiment.companionId, companionId))
      .catch((error: unknown) =>
        this.logger.error('failed to record presence on the embodiment claim', {
          operation: 'embodiment.presence',
          companionId,
          error,
        }),
      );
  }
}

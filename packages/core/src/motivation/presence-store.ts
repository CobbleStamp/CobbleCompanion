/**
 * Presence store — a volatile, in-memory record of each companion's latest
 * presence signal (companion-motivation.md §4). Presence is ephemeral by design:
 * it reflects "is the user here *now*", so it is never persisted and a restart
 * just resets it (the engine then treats the companion as absent until the next
 * heartbeat). Updated by the heartbeat route and by the user sending a message.
 */

import type { PresenceSignal } from './presence.js';

/**
 * The exact claim a presence write belongs to — the embodiment fencing key
 * (`connectionId` + DB-stamped `claimSeq`). A claim-backed store scopes the write
 * to this key so a write that passes the dispatcher's `holds()` fence and then
 * loses the claim before it lands (a TOCTOU handoff) self-fences instead of
 * stomping the successor's presence signal. Stores with no claim concept (the
 * in-memory single-process store) accept it for interface parity and ignore it.
 */
export interface PresenceFence {
  readonly connectionId: string;
  readonly claimSeq: number;
}

export interface PresenceStore {
  /** Record a client heartbeat (tab focus/visibility), refreshing presence. */
  recordHeartbeat(companionId: string, opts: { tabVisible: boolean; fence: PresenceFence }): void;
  /** Record real user activity (e.g. sending a message) — implies `active`. */
  recordActivity(companionId: string, fence: PresenceFence): void;
  /** The latest signal, or null if the companion is not present (no live claim /
   *  not seen this run). Async — a claim-backed store (D5) reads shared Postgres. */
  get(companionId: string): Promise<PresenceSignal | null>;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly signals = new Map<string, PresenceSignal>();
  private readonly now: () => Date;

  constructor(now: () => Date = (): Date => new Date()) {
    this.now = now;
  }

  // The in-memory store has no claim concept (single process, keyed by companion),
  // so the fence is moot here and accepted only for interface parity with the
  // claim-backed D5 store.
  recordHeartbeat(companionId: string, opts: { tabVisible: boolean; fence: PresenceFence }): void {
    const existing = this.signals.get(companionId);
    const at = this.now();
    // Heartbeat refreshes liveness + visibility but does NOT count as activity —
    // a heartbeat with the tab idle keeps the user `attentive`, not `active`.
    this.signals.set(companionId, {
      lastActivityAt: existing?.lastActivityAt ?? at,
      lastHeartbeatAt: at,
      tabVisible: opts.tabVisible,
    });
  }

  recordActivity(companionId: string, _fence: PresenceFence): void {
    const existing = this.signals.get(companionId);
    const at = this.now();
    // Real activity also implies the user is here and the tab is in front.
    this.signals.set(companionId, {
      lastActivityAt: at,
      lastHeartbeatAt: at,
      tabVisible: existing?.tabVisible ?? true,
    });
  }

  async get(companionId: string): Promise<PresenceSignal | null> {
    return this.signals.get(companionId) ?? null;
  }
}

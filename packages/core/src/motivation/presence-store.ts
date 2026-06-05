/**
 * Presence store — a volatile, in-memory record of each companion's latest
 * presence signal (companion-motivation.md §4). Presence is ephemeral by design:
 * it reflects "is the user here *now*", so it is never persisted and a restart
 * just resets it (the engine then treats the companion as absent until the next
 * heartbeat). Updated by the heartbeat route and by the user sending a message.
 */

import type { PresenceSignal } from './presence.js';

export interface PresenceStore {
  /** Record a client heartbeat (tab focus/visibility), refreshing presence. */
  recordHeartbeat(companionId: string, opts: { tabVisible: boolean }): void;
  /** Record real user activity (e.g. sending a message) — implies `active`. */
  recordActivity(companionId: string): void;
  /** The latest signal, or null if the companion has not been seen this run. */
  get(companionId: string): PresenceSignal | null;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly signals = new Map<string, PresenceSignal>();
  private readonly now: () => Date;

  constructor(now: () => Date = (): Date => new Date()) {
    this.now = now;
  }

  recordHeartbeat(companionId: string, opts: { tabVisible: boolean }): void {
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

  recordActivity(companionId: string): void {
    const existing = this.signals.get(companionId);
    const at = this.now();
    // Real activity also implies the user is here and the tab is in front.
    this.signals.set(companionId, {
      lastActivityAt: at,
      lastHeartbeatAt: at,
      tabVisible: existing?.tabVisible ?? true,
    });
  }

  get(companionId: string): PresenceSignal | null {
    return this.signals.get(companionId) ?? null;
  }
}

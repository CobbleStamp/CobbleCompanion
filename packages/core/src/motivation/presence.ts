/**
 * Presence — the dominant environment signal the motivation engine reads
 * (companion-motivation.md §4). It answers "how *here* is the user right now?" as
 * a spectrum, derived from a client heartbeat (tab focus/visibility) plus the
 * recency of the user's last real activity. Presence is volatile (held in memory,
 * see presence-store.ts) — a restart simply resets it.
 *
 * The state shapes the engine's posture: when the user is actively engaged it
 * should not wander off into solo work; when present-but-idle is the best moment
 * to act; when away it does solo work that surfaces on return.
 */

export type PresenceState = 'active' | 'attentive' | 'away_short' | 'absent_long';

/** The raw inputs a presence classification is computed from. */
export interface PresenceSignal {
  /** When the user last *did* something (sent a message / interacted). */
  readonly lastActivityAt: Date;
  /** When the client last checked in (the heartbeat). */
  readonly lastHeartbeatAt: Date;
  /** Whether the tab was focused/visible at the last heartbeat. */
  readonly tabVisible: boolean;
}

/** Tunable windows that bound the spectrum. */
export interface PresenceThresholds {
  /** Activity newer than this → `active` (user is mid-interaction). */
  readonly activeWithinMs: number;
  /** Heartbeat newer than this, tab visible → `attentive` (here but idle). */
  readonly attentiveWithinMs: number;
  /** Heartbeat newer than this → `away_short`; older → `absent_long`. */
  readonly awayWithinMs: number;
}

export const DEFAULT_PRESENCE_THRESHOLDS: PresenceThresholds = {
  activeWithinMs: 30_000, // 30s since last activity
  attentiveWithinMs: 10 * 60_000, // 10 minutes
  awayWithinMs: 3 * 60 * 60_000, // 3 hours
};

/**
 * Classify presence from a signal. Pure (clock injected as `now`) so the spectrum
 * is exhaustively unit-testable. A missing signal (never seen) is treated as
 * `absent_long` by the caller (`null` → absent), so this only handles a present
 * signal.
 */
export function classifyPresence(
  signal: PresenceSignal,
  now: Date,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): PresenceState {
  const activityAge = now.getTime() - signal.lastActivityAt.getTime();
  const heartbeatAge = now.getTime() - signal.lastHeartbeatAt.getTime();

  if (activityAge <= thresholds.activeWithinMs) {
    return 'active';
  }
  if (signal.tabVisible && heartbeatAge <= thresholds.attentiveWithinMs) {
    return 'attentive';
  }
  if (heartbeatAge <= thresholds.awayWithinMs) {
    return 'away_short';
  }
  return 'absent_long';
}

/** What a presence state means for the engine's behaviour. */
export interface PresencePosture {
  /** May the engine consider self-initiating at all in this state? */
  readonly mayInitiate: boolean;
  /** A short rationale, for logs/debugging. */
  readonly hint: string;
}

/**
 * The posture per state. `active` suppresses self-initiation — the user is
 * mid-interaction, so the companion responds rather than wandering into solo work
 * (companion-motivation.md §4). Every other state allows the engine to act
 * (subject to drives/energy/dial); idle is still always a valid outcome.
 */
export const PRESENCE_POSTURE: Record<PresenceState, PresencePosture> = {
  active: { mayInitiate: false, hint: 'user is engaged — respond, do not self-initiate' },
  attentive: { mayInitiate: true, hint: 'present but idle — the best moment to act' },
  away_short: { mayInitiate: true, hint: 'away — do solo work that surfaces on return' },
  absent_long: { mayInitiate: true, hint: 'absent — catch-up posture' },
};

/** Convenience: classify, then resolve the posture (absent when no signal yet). */
export function presencePosture(
  signal: PresenceSignal | null,
  now: Date,
  thresholds?: PresenceThresholds,
): { state: PresenceState; posture: PresencePosture } {
  const state = signal ? classifyPresence(signal, now, thresholds) : 'absent_long';
  return { state, posture: PRESENCE_POSTURE[state] };
}

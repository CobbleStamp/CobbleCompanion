/**
 * Greeting arbitration (Phase 14, companion-greeting.md §4) — the token-free
 * heuristic gate that decides *whether* the companion greets on the user's
 * arrival, and in what register. A pure function of the arrival gap, the
 * relationship, the dial, and whether anything is unfinished — so the whole
 * decision space is exhaustively unit-testable (the sibling of arbitration.ts
 * `decideMove`). Returns `null` (stay quiet) for a continuation, an `off` dial,
 * or a gap/substance that doesn't clear the dial's bar. Stamina is NOT consulted
 * here — it changes only *how* the move is voiced (a real greeting vs. the fixed
 * exhausted line), decided at execution time (companion-greeting.md §4 gate 5).
 */

import type { ProactivityDial } from '@cobble/shared';

/** The register a greeting is voiced in. */
export type GreetingKind =
  /** First-ever co-presence — the companion introduces itself (overrides the dial). */
  | 'introduce'
  /** An ordinary return — a reconnect scaled to the gap and relationship depth. */
  | 'greet';

/** The chosen greeting move. `null` from {@link decideGreeting} means stay quiet. */
export interface GreetingMove {
  readonly kind: GreetingKind;
}

export interface GreetingDecisionInput {
  /** No prior `last_seen_at` — the user and companion have never met. */
  readonly firstMeeting: boolean;
  /** `now − last_seen_at` in ms (ignored when `firstMeeting`). */
  readonly gapMs: number;
  readonly dial: ProactivityDial;
  /** Any unfinished business to pick up (a pending approval, an unanswered question, …). */
  readonly hasOpenLoop: boolean;
}

/**
 * A return below this is a *continuation* (a brief tab-away), not a reunion — no
 * greeting. Separates "stepped away for coffee" from "came back".
 */
export const CONTINUATION_FLOOR_MS = 30 * 60_000; // 30 minutes

/** `active` greets on a return older than this (or any open loop). */
export const ACTIVE_GAP_MS = 60 * 60_000; // 1 hour

/** `gentle` greets only on a return older than this (or any open loop). */
export const GENTLE_GAP_MS = 24 * 60 * 60_000; // 1 day

/**
 * Decide whether to greet, and in what register. Order matters — the cheapest,
 * most decisive gates run first (companion-greeting.md §4):
 *   1. first meeting → introduce (overrides the dial — a blank screen is a broken
 *      first impression, and the dial governs *ongoing* initiative);
 *   2. `off` → stay quiet (reactive-only);
 *   3. below the continuation floor → stay quiet (a brief tab-away);
 *   4. else greet only when the gap × substance clears the dial's threshold.
 */
export function decideGreeting(input: GreetingDecisionInput): GreetingMove | null {
  if (input.firstMeeting) {
    return { kind: 'introduce' };
  }
  if (input.dial === 'off') {
    return null;
  }
  if (input.gapMs < CONTINUATION_FLOOR_MS) {
    return null;
  }
  if (input.dial === 'gentle') {
    return input.hasOpenLoop || input.gapMs >= GENTLE_GAP_MS ? { kind: 'greet' } : null;
  }
  // active
  return input.gapMs >= ACTIVE_GAP_MS || input.hasOpenLoop ? { kind: 'greet' } : null;
}

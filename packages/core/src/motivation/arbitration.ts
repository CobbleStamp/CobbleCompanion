/**
 * Arbitration (Phase 4, companion-motivation.md §5) — the token-free heuristic
 * gate that decides *whether* to act, and on what. It multiplies each drive's
 * level by its learned weight (`pressure = level × weight`), checks the
 * environment (presence, dial, energy), and returns the best move only if it
 * clears the dial's threshold. Otherwise it returns `null` — idle is a valid,
 * free outcome. Only when a move is returned does the engine spend energy.
 *
 * v1 has a single behaviour family (`explore`, driven by curiosity), so the
 * scoring is a one-drive comparison; the structure generalizes to scoring many
 * behaviours when conversational moves land.
 */

import type { PersonalityKnobs, ProactivityDial } from '@cobble/shared';
import type { DriveLevels } from './drives.js';
import type { DriveWeights } from '@cobble/shared';
import { PRESENCE_POSTURE, type PresenceState } from './presence.js';

/**
 * Default "creature" constants in the PoC (personalized via onboarding later).
 *
 * v1 reads only `focusLength` (the explore-burst limit, below). `boredom` and
 * `distractibility` are persisted in the knob shape but **inert in v1**: they
 * describe per-step satiation decay and mid-burst preemption, which need a
 * multi-step inner loop and competing behaviour families that v1 does not have
 * (the tick is single-shot over the one `explore` behaviour). They activate with
 * the multi-behaviour loop deferred alongside conversational proactivity — see
 * `docs/companion-motivation.md` §6, §10. Kept here so the persisted shape and
 * the `PersonalityKnobs` contract stay stable.
 */
export const DEFAULT_KNOBS: PersonalityKnobs = {
  focusLength: 3,
  boredom: 0.5,
  distractibility: 0.5,
};

/**
 * Initiation threshold by dial — higher is more sparing. `off` never acts
 * (Infinity). Tuned so `gentle` needs a few unread leads before it initiates and
 * `active` initiates more readily.
 */
const DIAL_THRESHOLD: Record<ProactivityDial, number> = {
  off: Number.POSITIVE_INFINITY,
  gentle: 0.3,
  active: 0.15,
};

/**
 * Rough energy a single autonomous read costs (the two ingestion passes + embed +
 * a share of the report note). Used only to size the burst against remaining
 * energy so the companion self-regulates — it scopes its plan to what it can
 * afford rather than only stopping when the pool hits zero. Real spend is metered
 * exactly; this is a planning estimate, deliberately on the high side.
 */
export const ESTIMATED_READ_COST_TOKENS = 1500;

/** The chosen proactive move. v1 only ever explores the reading list. */
export interface ExploreMove {
  readonly kind: 'explore';
  /** Max leads to work this burst (bounded by focus length). */
  readonly limit: number;
  /** The dominant drive and its pressure, for logging + reward attribution. */
  readonly drive: 'curiosity';
  readonly pressure: number;
}

export type Move = ExploreMove;

export interface ArbitrationInput {
  readonly levels: DriveLevels;
  readonly weights: DriveWeights;
  readonly presence: PresenceState;
  readonly dial: ProactivityDial;
  /** Tokens of energy left in the current window — sizes the burst (§8). */
  readonly energyRemaining: number;
  readonly knobs: PersonalityKnobs;
}

/**
 * Decide whether to initiate, and how. Returns `null` (idle) when the dial is
 * off, energy is exhausted, the user is actively engaged (don't self-initiate),
 * or no drive clears the threshold.
 */
export function decideMove(input: ArbitrationInput): Move | null {
  if (input.dial === 'off') {
    return null;
  }
  // Out of energy → idle (chat still runs on stamina). Below one read's worth,
  // there's nothing it can afford, so treat that as exhausted too.
  const affordable = Math.floor(input.energyRemaining / ESTIMATED_READ_COST_TOKENS);
  if (affordable < 1) {
    return null;
  }
  // Don't wander into solo work while the user is mid-interaction (§4).
  if (!PRESENCE_POSTURE[input.presence].mayInitiate) {
    return null;
  }

  // v1: the only behaviour is exploring the reading list, driven by curiosity.
  const pressure = input.levels.curiosity * input.weights.curiosity;
  if (pressure < DIAL_THRESHOLD[input.dial]) {
    return null;
  }

  // Energy-aware planning: dwell up to focus length, but never plan more reads
  // than the remaining energy can pay for (self-regulation, §6/§8).
  const focus = Math.max(1, Math.round(input.knobs.focusLength));
  const limit = Math.min(focus, affordable);
  return { kind: 'explore', limit, drive: 'curiosity', pressure };
}

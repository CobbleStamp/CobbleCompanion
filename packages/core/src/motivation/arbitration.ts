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

/** Default "creature" constants in the PoC (personalized via onboarding later). */
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
  readonly energyExhausted: boolean;
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
  if (input.energyExhausted) {
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

  const limit = Math.max(1, Math.round(input.knobs.focusLength));
  return { kind: 'explore', limit, drive: 'curiosity', pressure };
}

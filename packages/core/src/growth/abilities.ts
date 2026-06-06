/**
 * The abilities registry (development-plan.md §3) — the closed catalogue of
 * capabilities the companion can DEMONSTRATE, each with a human label and a pure
 * predicate over the {@link GrowthSubstrate}. Abilities are observational (read off
 * the existing tool/procedure/reward/affect logs), unlock once, and never re-lock.
 * Adding a capability is one entry here; the order is the checklist's display order.
 */

import type { AbilityDto, AbilityKey } from '@cobble/shared';
import type { GrowthSubstrate } from './substrate.js';

interface AbilityDef {
  readonly key: AbilityKey;
  readonly label: string;
  /** True once the companion has demonstrated this capability. */
  readonly demonstrated: (substrate: GrowthSubstrate) => boolean;
}

/**
 * `multi_step_task` is approximated as "ran at least two tool actions" — the
 * substrate has no per-turn iteration count, so this is the honest, deterministic
 * proxy for the companion having taken more than one action (development-plan.md §3).
 */
const MULTI_STEP_TOOL_CALLS = 2;

export const ABILITIES: readonly AbilityDef[] = [
  {
    key: 'web_research',
    label: 'Web research',
    demonstrated: (s) => s.distinctToolNames.includes('web_fetch'),
  },
  {
    key: 'memory_recall',
    label: 'Memory recall',
    demonstrated: (s) => s.distinctToolNames.includes('memory_search'),
  },
  {
    key: 'reading_sources',
    label: 'Reading sources',
    demonstrated: (s) => s.sourceCount > 0,
  },
  {
    key: 'self_directed_work',
    label: 'Self-directed exploration',
    demonstrated: (s) => s.hasAutonomousWork,
  },
  {
    key: 'first_routine',
    label: 'A learned routine',
    demonstrated: (s) => s.procedureCount > 0,
  },
  {
    key: 'multi_step_task',
    label: 'Multi-step tasks',
    demonstrated: (s) => s.toolCallTotal >= MULTI_STEP_TOOL_CALLS,
  },
  {
    key: 'mood_attunement',
    label: 'Reading your mood',
    demonstrated: (s) => s.hasMoodSense,
  },
];

/** The set of ability keys the companion currently qualifies for (display order). */
export function computeUnlocked(substrate: GrowthSubstrate): readonly AbilityKey[] {
  return ABILITIES.filter((ability) => ability.demonstrated(substrate)).map(
    (ability) => ability.key,
  );
}

/**
 * The full checklist (every ability, flagged unlocked or not) for the surface,
 * given the set the companion currently qualifies for. Display order = registry order.
 */
export function abilityChecklist(unlocked: readonly AbilityKey[]): readonly AbilityDto[] {
  const unlockedSet = new Set(unlocked);
  return ABILITIES.map((ability) => ({
    key: ability.key,
    label: ability.label,
    unlocked: unlockedSet.has(ability.key),
  }));
}

/** The human label for an ability key (for growth notes); the key itself if unknown. */
export function abilityLabel(key: AbilityKey): string {
  return ABILITIES.find((ability) => ability.key === key)?.label ?? key;
}

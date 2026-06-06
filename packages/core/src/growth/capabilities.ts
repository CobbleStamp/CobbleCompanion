/**
 * The capabilities registry (development-plan.md §3) — the closed catalogue of
 * capabilities the companion can DEMONSTRATE, each with a human label and a pure
 * predicate over the {@link GrowthSubstrate}. Capabilities are observational (read off
 * the existing tool/procedure/affect logs); a MIRROR, not an achievement board, so
 * `observed` reflects what the logs currently show rather than a reward that locks in.
 * Autonomous work is reflected by the Initiative axis, not here. Adding a capability
 * is one entry here; the order is the checklist's display order.
 */

import type { CapabilityDto, CapabilityKey } from '@cobble/shared';
import type { GrowthSubstrate } from './substrate.js';

interface CapabilityDef {
  readonly key: CapabilityKey;
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

export const CAPABILITIES: readonly CapabilityDef[] = [
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

/** The set of capability keys the companion currently qualifies for (display order). */
export function computeObserved(substrate: GrowthSubstrate): readonly CapabilityKey[] {
  return CAPABILITIES.filter((capability) => capability.demonstrated(substrate)).map(
    (capability) => capability.key,
  );
}

/**
 * The full checklist (every capability, flagged observed or not) for the surface,
 * given the set the companion currently qualifies for. Display order = registry order.
 */
export function capabilityChecklist(observed: readonly CapabilityKey[]): readonly CapabilityDto[] {
  const observedSet = new Set(observed);
  return CAPABILITIES.map((capability) => ({
    key: capability.key,
    label: capability.label,
    observed: observedSet.has(capability.key),
  }));
}

/** The human label for a capability key (for growth notes); the key itself if unknown. */
export function capabilityLabel(key: CapabilityKey): string {
  return CAPABILITIES.find((capability) => capability.key === key)?.label ?? key;
}

/**
 * The mission-context retrieve arm (companion-missions.md §3.4). When the companion has an
 * `active` mission, this injects the goal + plan + success criteria + recent journal into the
 * turn's context, so every turn while the mission runs — a trigger-driven advance or the owner
 * chatting — is mission-aware and has cross-day continuity ("what I concluded last time")
 * without rescanning the transcript. Composed into the single invariant-#3 retrieve hook by
 * {@link composeRetrieveContext}; contributes nothing when there is no active mission.
 *
 * Pure DB reads (no embedding), so it spends no tokens.
 */

import type { ContextBlock, RetrieveContext, RetrieveResult } from '../harness/hooks.js';
import { ZERO_USAGE } from '../usage.js';
import { DEFAULT_JOURNAL_RECALL } from './mission-service.js';
import type { MissionJournalRecord, MissionJournalStore, MissionRecord } from './mission-store.js';
import type { MissionStore } from './mission-store.js';

export interface MissionRetrieveOptions {
  /** How many recent journal rows to recall (default {@link DEFAULT_JOURNAL_RECALL}). */
  readonly recall?: number;
}

export function createMissionRetrieveContext(
  missions: MissionStore,
  journal: MissionJournalStore,
  options: MissionRetrieveOptions = {},
): RetrieveContext {
  const recall = options.recall ?? DEFAULT_JOURNAL_RECALL;
  return async ({ companionId }): Promise<RetrieveResult> => {
    const mission = await missions.findActive(companionId);
    if (!mission) {
      return { blocks: [], usage: ZERO_USAGE };
    }
    const recent = await journal.recent(mission.id, recall);
    const block: ContextBlock = { role: 'system', content: renderMissionContext(mission, recent) };
    return { blocks: [block], usage: ZERO_USAGE };
  };
}

/** Render the active mission + its recent journal as a single grounding block. */
function renderMissionContext(
  mission: MissionRecord,
  recent: readonly MissionJournalRecord[],
): string {
  const lines = [
    'You are on an active mission. Serve it; stop only when its success criteria are met or you are told to.',
    `Goal: ${mission.goal}`,
  ];
  if (mission.plan) lines.push(`Plan: ${mission.plan}`);
  if (mission.validationCriteria) lines.push(`Success criteria: ${mission.validationCriteria}`);
  if (recent.length > 0) {
    lines.push('Recent progress (most recent first):');
    for (const row of recent) {
      const parts = [row.findings, row.prediction, row.decision].filter(
        (p): p is string => p !== null && p.length > 0,
      );
      const summary = parts.length > 0 ? parts.join(' · ') : '(no conclusion recorded)';
      lines.push(`- ${row.turnAt.toISOString()}: ${summary}`);
    }
  } else {
    lines.push('No progress recorded yet — this is the first turn of the mission.');
  }
  return lines.join('\n');
}

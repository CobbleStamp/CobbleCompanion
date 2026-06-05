/**
 * Motivation catch-up sweep (Phase 4) — mirrors the consolidation sweep. On
 * startup and on a timer it requests a proactive tick for every companion worth
 * one (those with at least one unread lead). Best-effort: a worklist failure or a
 * single bad request is logged, never fatal. The engine's gate still decides
 * whether each requested companion actually initiates.
 */

import type { Logger } from '../logging.js';
import type { LeadStore } from '../tools/lead-store.js';
import type { MotivationRunner } from './engine-runner.js';

export interface MotivationSweepDeps {
  readonly leads: LeadStore;
  readonly runner: MotivationRunner;
  readonly logger: Logger;
}

/** Request a tick for each companion with pending leads. Returns the count requested. */
export async function sweepMotivation(deps: MotivationSweepDeps): Promise<number> {
  let companionIds: readonly string[];
  try {
    companionIds = await deps.leads.companionsWithNewLeads();
  } catch (error) {
    deps.logger.error('motivation sweep failed', {
      operation: 'motivation.sweep',
      error,
    });
    return 0;
  }
  let requested = 0;
  for (const companionId of companionIds) {
    try {
      deps.runner.request(companionId);
      requested += 1;
    } catch (error) {
      deps.logger.error('motivation sweep failed to request a companion', {
        operation: 'motivation.sweep',
        companionId,
        error,
      });
    }
  }
  return requested;
}

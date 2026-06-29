/**
 * Motivation catch-up sweep (Phase 4) — mirrors the consolidation sweep. On
 * startup and on a timer it requests a proactive tick for every companion worth
 * one (those with at least one unread lead). Best-effort: a worklist failure or a
 * single bad request is logged, never fatal. The engine's gate still decides
 * whether each requested companion actually initiates.
 */

import type { Logger } from '../logging.js';
import { sweepCompanions, type CompanionRequester } from '../jobs/sweep.js';
import type { LeadStore } from '../tools/lead-store.js';

export interface MotivationSweepDeps {
  readonly leads: LeadStore;
  /**
   * Anything that turns a companion id into a requested tick — the job-queue
   * work requester. Structural so the sweep is agnostic to what drains the work.
   */
  readonly runner: CompanionRequester;
  readonly logger: Logger;
}

/** Request a tick for each companion with pending leads. Returns the count requested. */
export async function sweepMotivation(deps: MotivationSweepDeps): Promise<number> {
  return sweepCompanions(
    () => deps.leads.companionsWithNewLeads(),
    deps.runner,
    deps.logger,
    'motivation.sweep',
  );
}

/**
 * Catch-up sweep — the shared "load a worklist of companions, request a job for
 * each, isolate per-companion failures, return the count" loop behind the
 * motivation (engine-sweep.ts) and consolidation (consolidation-service.ts)
 * sweeps. Both are best-effort startup/timer catch-up: a worklist failure or a
 * single bad request is logged (distinguished by `operation`), never fatal — the
 * job's own gate decides whether a requested companion actually does work.
 */

import type { Logger } from '../logging.js';

/** Anything that turns a companion id into a requested job (the job-pool requester). */
export interface CompanionRequester {
  request(companionId: string): void;
}

/**
 * Request a job for every companion the `worklist` returns, isolating each
 * `request()` so one failure never aborts the rest. Returns the number requested;
 * returns 0 (logged) if the worklist query itself fails.
 */
export async function sweepCompanions(
  worklist: () => Promise<readonly string[]>,
  runner: CompanionRequester,
  logger: Logger,
  operation: string,
): Promise<number> {
  let companionIds: readonly string[];
  try {
    companionIds = await worklist();
  } catch (error) {
    logger.error('sweep failed to load its worklist', { operation, error });
    return 0;
  }
  let requested = 0;
  for (const companionId of companionIds) {
    try {
      runner.request(companionId);
      requested += 1;
    } catch (error) {
      logger.error('sweep failed to request a companion', { operation, companionId, error });
    }
  }
  return requested;
}

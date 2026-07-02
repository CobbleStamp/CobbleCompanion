/**
 * Mission wake-job reconciliation (companion-missions.md §5.2 step 1) — the framework-free
 * policy the mission WS methods and the `start_mission` tool share, so it lives here rather
 * than inlined in a transport handler (architecture-rules R1) and is unit-testable without a
 * WS harness.
 *
 * Two pieces:
 * - {@link reconcileMissionJobs} — the cancel-and-record primitive behind `mission.stop`, the
 *   stale-wake skip path, and `start_mission`'s activate-failure compensation.
 * - {@link routeMissionAdvance} — the "does this wake earn a turn?" decision: resolve the
 *   NAMED mission, skip anything that is not this companion's active one, and reconcile a
 *   terminal mission's stale jobs on the way out.
 */

import type { Logger } from '../logging.js';
import type { MissionScheduler } from './mission-scheduler.js';
import { isMissionTerminal, type MissionService } from './mission-service.js';
import type { MissionRecord } from './mission-store.js';

/** The stores a reconciliation touches: the mission lifecycle + the scheduler that armed it. */
export interface MissionReconcileDeps {
  readonly missions: MissionService;
  readonly scheduler: MissionScheduler;
  readonly logger: Logger;
}

/**
 * Cancel a mission's wake jobs (best-effort, each failure logged) and settle the armed-job
 * list — drop the ids whose cancel SUCCEEDED, keep the ones that FAILED — so a later
 * reconciliation retries exactly the survivors and nothing else. Returns the still-armed ids.
 *
 * Both halves are best-effort: a failed cancel is recorded so it can be retried; a failed
 * write is logged and swallowed (the row keeps its prior ids, and the next wake reconciles
 * afresh) — reconciliation must never throw out into its caller and block a stop or a
 * compensation. The write is a race-safe delta ({@link MissionService.reconcileJobs}), so two
 * reconciliations of the same mission compose instead of clobbering.
 */
export async function reconcileMissionJobs(
  deps: MissionReconcileDeps,
  missionId: string,
  jobIds: readonly string[],
): Promise<readonly string[]> {
  const cancelled: string[] = [];
  const failed: string[] = [];
  for (const jobId of jobIds) {
    try {
      await deps.scheduler.cancel(jobId);
      cancelled.push(jobId);
    } catch (error) {
      failed.push(jobId);
      deps.logger.error('failed to cancel a mission wake job', {
        operation: 'mission.reconcile.cancel',
        missionId,
        jobId,
        error,
      });
    }
  }
  if (cancelled.length > 0 || failed.length > 0) {
    try {
      await deps.missions.reconcileJobs(missionId, cancelled, failed);
    } catch (error) {
      deps.logger.error('failed to settle the wake-job list after a cancel pass', {
        operation: 'mission.reconcile.record',
        missionId,
        error,
      });
    }
  }
  return failed;
}

/** Whether a wake should run a turn (the mission is live) or be skipped (with the reason). */
export type AdvanceRouting =
  | { readonly kind: 'advance'; readonly mission: MissionRecord }
  | { readonly kind: 'skip'; readonly reason: string };

/**
 * Resolve the wake's NAMED mission and decide whether it earns a turn (companion-missions.md
 * §3.2, §5.2 step 1). An unknown id, another companion's mission, or a non-active one all
 * skip cheaply — no stamina burned, nothing journaled. A TERMINAL mission's wake IS a stale
 * job that outlived it (a `mission.stop` whose scheduler cancel failed), so its jobs are
 * reconciled here or it fires every interval forever; a `draft` mission is a mission mid-start
 * (arm→activate window) and its jobs are left alone. Only an `active` mission owned by
 * `companionId` returns `advance`.
 */
export async function routeMissionAdvance(
  deps: MissionReconcileDeps,
  companionId: string,
  missionId: string,
): Promise<AdvanceRouting> {
  const mission = await deps.missions.get(missionId);
  if (!mission || mission.companionId !== companionId) {
    // Unknown id, or another companion's mission (don't leak which): nothing to advance,
    // and no job record to reconcile against — log loudly so the stray job is findable.
    deps.logger.error('mission.advance for an unknown mission — skipping the turn', {
      operation: 'mission.advance',
      companionId,
      missionId,
    });
    return { kind: 'skip', reason: 'unknown mission' };
  }
  if (mission.status !== 'active') {
    deps.logger.info('mission.advance for a non-active mission — skipping the turn', {
      operation: 'mission.advance',
      companionId,
      missionId,
      status: mission.status,
    });
    if (isMissionTerminal(mission.status) && mission.jobIds.length > 0) {
      const stillArmed = await reconcileMissionJobs(deps, mission.id, mission.jobIds);
      deps.logger.info('reconciled stale mission wake jobs after a skipped advance', {
        operation: 'mission.advance.reconcile',
        companionId,
        missionId: mission.id,
        cancelled: mission.jobIds.length - stillArmed.length,
        stillArmed: stillArmed.length,
      });
    }
    return { kind: 'skip', reason: 'mission not active' };
  }
  return { kind: 'advance', mission };
}

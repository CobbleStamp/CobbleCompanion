/**
 * MissionService (companion-missions.md §4) — the lifecycle orchestration over the
 * mission stores that the WS methods (`mission.*`) and the advance path call. It owns the
 * status transitions (create → activate → stop) and the append-only journal; it does NOT
 * run the planner or the advance turn (those are harness turns), and it does NOT poke the
 * drive engine — suspension is a query (`hasActive`), so leaving `active` auto-resumes
 * drives on the next motivation tick. The autonomous transitions the deferred
 * validate→decide loop will need (pause/complete/fail, per-turn re-arm) are added with
 * that milestone (companion-missions.md §11), not scaffolded here.
 *
 * Transition guards here are best-effort (read-then-set); the DB backstops the load-bearing
 * invariant (at most one `active` mission per companion) with a partial unique index, so a
 * racing double-activate fails at the store, not silently.
 */

import type { MissionStatus } from '@cobble/shared';
import type {
  MissionActivation,
  MissionJournalInput,
  MissionJournalRecord,
  MissionJournalStore,
  MissionRecord,
  MissionStore,
} from './mission-store.js';

/** How many recent journal rows the advance turn recalls for continuity (§4). */
export const DEFAULT_JOURNAL_RECALL = 10;

/** A lifecycle status a mission can no longer move out of. */
const TERMINAL: readonly MissionStatus[] = ['complete', 'stopped', 'failed'];

/**
 * Whether a mission is in a terminal status — one it can never leave. A wake job found
 * armed on a terminal mission is stale by definition (safe to cancel); one on a `draft`
 * is a mission mid-start (arm→activate window) and must be left alone.
 */
export function isMissionTerminal(status: MissionStatus): boolean {
  return TERMINAL.includes(status);
}

export class MissionService {
  constructor(
    private readonly missions: MissionStore,
    private readonly journal: MissionJournalStore,
  ) {}

  /** Create a `draft` mission from an assigned goal (the planner fills plan/criteria/jobs). */
  createDraft(companionId: string, goal: string): Promise<MissionRecord> {
    return this.missions.create(companionId, goal);
  }

  list(companionId: string): Promise<MissionRecord[]> {
    return this.missions.listByCompanion(companionId);
  }

  get(missionId: string): Promise<MissionRecord | null> {
    return this.missions.findById(missionId);
  }

  /** The companion's single `active` mission (the trigger-routing target), or null. */
  findActive(companionId: string): Promise<MissionRecord | null> {
    return this.missions.findActive(companionId);
  }

  /** Whether the drive engine should be suspended for this companion (§1). */
  hasActive(companionId: string): Promise<boolean> {
    return this.missions.hasActive(companionId);
  }

  /**
   * Whether THIS specific mission is still `active` — the approval gate's mission-mode
   * bypass re-reads it per effectful call, keyed on the mission driving the turn (§6).
   */
  isActive(missionId: string): Promise<boolean> {
    return this.missions.isActive(missionId);
  }

  /**
   * Approve + activate a `draft` mission (draft-guarded at the store). Rejects at the DB if
   * another mission is already `active` for the companion (the one-active index); callers
   * guard with {@link hasActive} first.
   */
  activate(missionId: string, input: MissionActivation): Promise<MissionRecord | null> {
    return this.missions.activate(missionId, input);
  }

  /** Stop a mission (user-ended). No-op if already terminal; scheduler jobs cancelled separately. */
  async stop(missionId: string): Promise<MissionRecord | null> {
    const mission = await this.missions.findById(missionId);
    if (!mission || TERMINAL.includes(mission.status)) return null;
    return this.missions.setStatus(missionId, 'stopped');
  }

  /**
   * Settle a cancel pass on a mission's armed-job list, atomically: drop the ids whose
   * cancel succeeded (`cancelled`) and keep/record the ones that failed (`failed`), so a
   * later stale-trigger reconciliation retries exactly the survivors. Race-safe — see
   * {@link MissionStore.reconcileJobs}.
   */
  reconcileJobs(
    missionId: string,
    cancelled: readonly string[],
    failed: readonly string[],
  ): Promise<MissionRecord | null> {
    return this.missions.reconcileJobs(missionId, cancelled, failed);
  }

  /** Append one turn's outcome to the mission journal. */
  recordJournal(missionId: string, input: MissionJournalInput): Promise<MissionJournalRecord> {
    return this.journal.append(missionId, input);
  }

  /** The most-recent journal rows for a mission, newest first (advance-turn continuity). */
  recentJournal(
    missionId: string,
    limit: number = DEFAULT_JOURNAL_RECALL,
  ): Promise<MissionJournalRecord[]> {
    return this.journal.recent(missionId, limit);
  }
}

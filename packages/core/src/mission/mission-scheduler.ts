/**
 * The scheduler seam a mission drives (companion-missions.md §3.1): the poll-until-condition
 * wake job `start_mission` arms and that `mission.stop` / the stale-wake reconciliation cancel.
 * Kept in its own module (not `start-mission-tool.ts`) so both the tool AND the reconciliation
 * (`mission-reconcile.ts`) can depend on it without a cycle.
 */

/** The scheduler wake job a mission arms: poll `predicate` every `every`, then run `action`. */
export interface MissionJobSpec {
  /** The poll predicate CLI, e.g. `ibkr-cli query LITE le 810` (companion-missions.md §3.1). */
  readonly predicate: string;
  /** The poll interval, e.g. `1s` / `5m` (the scheduler `--every` value). */
  readonly every: string;
  /**
   * The action argv the scheduler runs when the predicate holds — carried as a pre-split
   * argv (not a shell string) so there is no quoting/`{{message}}`-escaping hazard. The
   * scheduler substitutes `{{message}}` per element (companion-missions.md §3.2).
   */
  readonly action: readonly string[];
}

/** Arms and cancels the scheduler jobs that drive a mission's wake (companion-missions.md §3.1). */
export interface MissionScheduler {
  /** Register a poll-until-condition job; resolves to the scheduler's job id. */
  arm(spec: MissionJobSpec): Promise<string>;
  /** Cancel a previously-armed job (compensation on a failed start, and on stop/complete). */
  cancel(jobId: string): Promise<void>;
}

/**
 * The scheduler seam a mission drives (companion-missions.md §3.1): the poll-until-condition
 * wake job `start_mission` arms and that `mission.stop` / the stale-wake reconciliation cancel.
 * Kept in its own module (not `start-mission-tool.ts`) so both the tool AND the reconciliation
 * (`mission-reconcile.ts`) can depend on it without a cycle.
 */

/**
 * When the scheduler evaluates a mission's predicate — exactly one of the scheduler's
 * two cadences: a poll interval (`--every`), or a cron expression evaluated in a named
 * IANA time zone (`--cron`/`--tz`, e.g. a weekday-morning report wake). The union makes
 * an interval+cron spec unrepresentable; the scheduler service revalidates regardless.
 */
export type MissionCadence =
  | {
      /** The poll interval, e.g. `1s` / `5m` (the scheduler `--every` value). */
      readonly every: string;
    }
  | {
      /** A 5-field cron expression, e.g. `30 7 * * 1-5` (the scheduler `--cron` value). */
      readonly cron: string;
      /** The IANA time zone the expression is evaluated in, e.g. `America/New_York`. */
      readonly tz: string;
    };

/** The scheduler wake job a mission arms: run `predicate` on `cadence`, then run `action`. */
export interface MissionJobSpec {
  /** The poll predicate CLI, e.g. `ibkr-cli query LITE le 810` (companion-missions.md §3.1). */
  readonly predicate: string;
  /** When the predicate is evaluated: a poll interval, or a cron schedule + time zone. */
  readonly cadence: MissionCadence;
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

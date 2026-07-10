/**
 * The `start_mission` tool (effectful) — the single up-front approval that begins a mission
 * (companion-missions.md §4, §5.1). The owner states a goal in an ordinary chat turn; the model
 * decomposes it and calls this tool with the plan + the machine predicate that drives the
 * wake; the shipped propose→approve gate (`tools/gate.ts`) holds it as a pending proposal and
 * EXITs the loop, so the owner confirms it in the Discord proposal card. On confirm the tool body
 * runs once: it creates the mission draft (so the wake can carry the mission's id), arms the
 * scheduler wake job (whose action @-mentions the companion bot and names the mission —
 * `mission:<id>` — so every trigger is identifiable, §3.2), and activates the mission — which
 * suspends the drive engine (an `active` mission is a query the motivation tick early-returns on).
 *
 * The mission is then the standing authorization: effectful tools run ungated inside its
 * `mission.advance` wake turns (the gate's turn-scoped mission-mode bypass — ordinary chat
 * stays gated), so this is the ONLY approval the mission ever asks for.
 */

import type { ToolResult, TurnCtx } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { MissionCadence, MissionScheduler } from './mission-scheduler.js';
import { reconcileMissionJobs } from './mission-reconcile.js';
import type { MissionService } from './mission-service.js';
import { readStringArg, type Tool, toolErrorMessage } from '../tools/tool.js';

/** The mission-channel + companion-bot ids needed to build the wake action (§3.2). */
export interface MissionWakeTarget {
  readonly missionChannelId: string;
  readonly botUserId: string;
}

/** Reads the owner's configured mission wake, or null if it isn't configured yet. */
export interface MissionWakeConfig {
  forOwner(ownerId: string): Promise<MissionWakeTarget | null>;
}

export interface StartMissionOptions {
  readonly missions: MissionService;
  readonly scheduler: MissionScheduler;
  readonly wakeConfig: MissionWakeConfig;
  readonly logger?: Logger;
}

const RESULT_NAME = 'start_mission';

const TOOL_DESCRIPTION =
  'Begin a long-running mission: register the monitoring job that wakes you and commit to ' +
  'the goal until its success criteria are met or you are told to stop. This starts autonomous ' +
  'background work — propose it for the user to approve; approval is the mission’s standing ' +
  'authorization (no further per-action approvals while it runs).';

/** JSON Schema for the tool arguments, advertised to the model via the gateway. */
const TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'The mission goal, in one sentence.' },
    plan: { type: 'string', description: 'How you will pursue the goal each time you wake.' },
    validationCriteria: {
      type: 'string',
      description: 'The observable condition that means the mission is complete (when to stop).',
    },
    predicate: {
      type: 'string',
      description:
        'The machine poll predicate the scheduler evaluates, e.g. "ibkr-cli query LITE le 810".',
    },
    every: {
      type: 'string',
      description:
        'How often to poll the predicate, e.g. "1s", "30s", "5m". Exactly one cadence: ' +
        'use every OR cron+tz, never both.',
    },
    cron: {
      type: 'string',
      description:
        'A 5-field cron expression for a time-of-day wake, e.g. "30 7 * * 1-5" (weekdays ' +
        '7:30am). Requires tz; mutually exclusive with every.',
    },
    tz: {
      type: 'string',
      description:
        'IANA time zone the cron expression is evaluated in, e.g. "Europe/London". ' +
        'Required with cron.',
    },
  },
  required: ['goal', 'plan', 'validationCriteria', 'predicate'],
  additionalProperties: false,
};

/** The tool's arguments, present and non-blank, cadence resolved (see {@link readArgs}). */
interface StartMissionArgs {
  readonly goal: string;
  readonly plan: string;
  readonly validationCriteria: string;
  readonly predicate: string;
  readonly cadence: MissionCadence;
}

/**
 * How one step of the start sequence ended: the value to carry forward, or the
 * user-facing failure to return from the tool (compensation already performed).
 */
type StepOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ToolResult };

/**
 * Per-field cap inside the proposal summary. The card is the owner's ONE review of the plan
 * before granting standing authorization, so plan + criteria must be visible — but the summary
 * lands in a Discord embed description (4096), so long fields are trimmed, not spilled.
 */
const SUMMARY_FIELD_MAX = 300;

/** Trim a summary field to {@link SUMMARY_FIELD_MAX}, whitespace collapsed, `…` when cut. */
function summaryField(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= SUMMARY_FIELD_MAX
    ? flat
    : `${flat.slice(0, SUMMARY_FIELD_MAX - 1).trimEnd()}…`;
}

/** {@link summaryField} for text rendered as inline code in the card: backticks are
 *  stripped so the value cannot break out of its own code span in the Discord embed. */
function codeField(text: string): string {
  return summaryField(text.replace(/`/gu, ''));
}

/**
 * Read the cadence args as exactly one of `every` XOR `cron`+`tz`, or null when the
 * combination is invalid (both, neither, or cron without tz — the scheduler's one-of
 * rule, enforced here so a bad combination fails before a draft is created).
 */
function readCadence(rawArgs: Record<string, unknown>): MissionCadence | null {
  const every = readStringArg(rawArgs, 'every');
  const cron = readStringArg(rawArgs, 'cron');
  const tz = readStringArg(rawArgs, 'tz');
  if (every && !cron && !tz) return { every };
  if (!every && cron && tz) return { cron, tz };
  return null;
}

/** Read the required string args + a valid cadence, or null when any is absent/invalid. */
function readArgs(rawArgs: Record<string, unknown>): StartMissionArgs | null {
  const goal = readStringArg(rawArgs, 'goal');
  const plan = readStringArg(rawArgs, 'plan');
  const validationCriteria = readStringArg(rawArgs, 'validationCriteria');
  const predicate = readStringArg(rawArgs, 'predicate');
  const cadence = readCadence(rawArgs);
  if (!goal || !plan || !validationCriteria || !predicate || !cadence) return null;
  return { goal, plan, validationCriteria, predicate, cadence };
}

/** Human-readable cadence for the proposal card and the started confirmation. */
function describeCadence(cadence: MissionCadence): string {
  return 'every' in cadence
    ? `every ${summaryField(cadence.every)}`
    : `on schedule \`${codeField(cadence.cron)}\` (${summaryField(cadence.tz)})`;
}

/**
 * The approval-card text — the owner's one up-front plan review (companion-missions.md
 * §5.1): what will be watched, the plan, and when it counts as complete.
 */
function buildProposalSummary(args: Record<string, unknown>): string {
  const goal = readStringArg(args, 'goal');
  const plan = readStringArg(args, 'plan');
  const validationCriteria = readStringArg(args, 'validationCriteria');
  const predicate = readStringArg(args, 'predicate');
  const cadence = readCadence(args);
  const head = goal ? `Start mission: ${summaryField(goal)}` : 'Start a mission';
  const lines = [
    predicate && cadence
      ? `${head} — monitor \`${codeField(predicate)}\` ${describeCadence(cadence)}`
      : head,
  ];
  if (plan) lines.push(`Plan: ${summaryField(plan)}`);
  if (validationCriteria) lines.push(`Done when: ${summaryField(validationCriteria)}`);
  return lines.join('\n');
}

/**
 * Build the mission wake action argv:
 * `discord-notify --channel <ch> --text "<@bot> mission:<id> {{message}}"`.
 * Every wake NAMES its mission (companion-missions.md §3.2): the id is stamped into the
 * text at arm time so the trigger parser and `mission.advance` route by identity, never
 * by guessing at "the" active mission. (The scheduler's job id cannot ride here — it is
 * minted by `arm` after this text is frozen; the mission record's `job_ids` carries it.)
 */
function wakeAction(target: MissionWakeTarget, missionId: string): readonly string[] {
  return [
    'discord-notify',
    '--channel',
    target.missionChannelId,
    '--text',
    `<@${target.botUserId}> mission:${missionId} {{message}}`,
  ];
}

function error(content: string): ToolResult {
  return { name: RESULT_NAME, content, isError: true };
}

/** Build the `start_mission` tool over the mission service + scheduler + wake config. */
export function createStartMissionTool(options: StartMissionOptions): Tool {
  const { missions, scheduler, wakeConfig } = options;
  const logger = options.logger ?? consoleLogger;

  const logFailure = (message: string, context: Record<string, unknown>): void => {
    logger.error(message, { operation: 'tool.start_mission', ...context });
  };

  /** Compensation: stop a draft that will never activate (best-effort, logged). */
  async function stopDraft(companionId: string, draftId: string): Promise<void> {
    await missions.stop(draftId).catch((stopErr: unknown) => {
      logFailure('start_mission failed to stop the draft during compensation', {
        companionId,
        missionId: draftId,
        error: stopErr,
      });
    });
  }

  /**
   * Compensation: cancel a wake job whose mission never activated. Delegates to the shared
   * {@link reconcileMissionJobs} — cancel best-effort, and if the cancel fails record the job
   * on the draft so the stale-wake reconciliation (companion-missions.md §5.2 step 1) retries
   * it (only `activate` writes `jobIds` and it never ran, so without this the armed job's id
   * would exist nowhere and the job would fire every interval forever).
   */
  async function cancelOrphanedJob(draftId: string, jobId: string): Promise<void> {
    await reconcileMissionJobs({ missions, scheduler, logger }, draftId, [jobId]);
  }

  /**
   * §5.1 step 2 — create the draft row first: the wake action must carry the mission id
   * (every trigger names its mission, §3.2), and the id doesn't exist until the row does.
   */
  async function createDraft(ctx: TurnCtx, goal: string): Promise<StepOutcome<string>> {
    try {
      const draft = await missions.createDraft(ctx.companionId, goal);
      return { ok: true, value: draft.id };
    } catch (err) {
      logFailure('start_mission failed to create the mission draft', {
        companionId: ctx.companionId,
        error: err,
      });
      return { ok: false, failure: error(`Error starting the mission: ${toolErrorMessage(err)}`) };
    }
  }

  /**
   * §5.1 step 3 — arm the scheduler wake job, its action naming the mission. On failure
   * the draft is stopped (compensation), so no phantom draft lingers.
   */
  async function armWakeJob(
    ctx: TurnCtx,
    args: StartMissionArgs,
    target: MissionWakeTarget,
    draftId: string,
  ): Promise<StepOutcome<string>> {
    try {
      const jobId = await scheduler.arm({
        predicate: args.predicate,
        cadence: args.cadence,
        action: wakeAction(target, draftId),
      });
      return { ok: true, value: jobId };
    } catch (err) {
      logFailure('start_mission failed to arm the scheduler wake job', {
        companionId: ctx.companionId,
        missionId: draftId,
        error: err,
      });
      await stopDraft(ctx.companionId, draftId);
      return {
        ok: false,
        failure: error(`Error arming the mission monitor: ${toolErrorMessage(err)}`),
      };
    }
  }

  /**
   * §5.1 step 4 — activate the draft (records the job, suspends drives). A fresh draft
   * should always activate; if it didn't (a race lost the one-active index) or the write
   * threw, cancel the just-armed job rather than leave it firing with no mission, and
   * stop the losing draft rather than leave it lingering as a phantom.
   */
  async function activateMission(
    ctx: TurnCtx,
    args: StartMissionArgs,
    draftId: string,
    jobId: string,
  ): Promise<StepOutcome<undefined>> {
    try {
      const activated = await missions.activate(draftId, {
        plan: args.plan,
        validationCriteria: args.validationCriteria,
        jobIds: [jobId],
      });
      if (activated) return { ok: true, value: undefined };
      await cancelOrphanedJob(draftId, jobId);
      await stopDraft(ctx.companionId, draftId);
      return {
        ok: false,
        failure: error('Error: could not activate the mission (another may have just started).'),
      };
    } catch (err) {
      logFailure('start_mission failed to activate the mission', {
        companionId: ctx.companionId,
        missionId: draftId,
        jobId,
        error: err,
      });
      await cancelOrphanedJob(draftId, jobId);
      await stopDraft(ctx.companionId, draftId);
      return { ok: false, failure: error(`Error starting the mission: ${toolErrorMessage(err)}`) };
    }
  }

  /** The confirmed start, run once: guards, then draft → arm → activate (§5.1). */
  async function run(rawArgs: Record<string, unknown>, ctx: TurnCtx): Promise<ToolResult> {
    const args = readArgs(rawArgs);
    if (!args) {
      return error(
        'Error: start_mission needs non-empty goal, plan, validationCriteria, predicate, and ' +
          'exactly one cadence — every, or cron with tz.',
      );
    }

    // One active mission per companion (companion-missions.md §3): refuse up front so the
    // common case never arms a job it can't activate. This is best-effort (the DB unique
    // index is the real backstop, caught in `activateMission` with full compensation).
    // Residual gap: a HARD kill (OOM / SIGKILL / host loss) between arm and activate skips
    // that in-process compensation, leaving an armed job whose id was never written to
    // `job_ids` — only `activate` writes it, and it never ran. There is NO self-recovery:
    // the wake keeps firing every `every` forever, skipping at `mission.advance` (`draft`
    // ≠ `active`, `job_ids` empty) without cancelling, and `mission.stop` can't reach it
    // (no recorded job id to cancel). Recovery is out-of-band — cancel the stray job via
    // the scheduler service's own job listing. Accepted for Milestone 1 (rare; a lingering
    // `draft` is `≠ active`, so it never blocks a new mission) — companion-missions.md §5.1.
    if (await missions.hasActive(ctx.companionId)) {
      return error('Error: this companion is already on an active mission — stop it first.');
    }

    // The wake must be configured (mission channel + the companion bot's own id) before a
    // mission can be armed — the scheduler action @-mentions the bot to deliver the trigger.
    const target = await wakeConfig.forOwner(ctx.ownerId);
    if (!target) {
      return error(
        'Error: the mission wake is not configured (missing mission channel or bot id) — ' +
          'set it in Discord settings before starting a mission.',
      );
    }

    const draft = await createDraft(ctx, args.goal);
    if (!draft.ok) return draft.failure;

    const job = await armWakeJob(ctx, args, target, draft.value);
    if (!job.ok) return job.failure;

    const activated = await activateMission(ctx, args, draft.value, job.value);
    if (!activated.ok) return activated.failure;

    return {
      name: RESULT_NAME,
      content:
        `Mission started: "${args.goal}". I’ll watch \`${args.predicate}\` ` +
        `${describeCadence(args.cadence)} and act until ${args.validationCriteria}.`,
    };
  }

  return {
    name: RESULT_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    effectful: true,
    proposalSummary: buildProposalSummary,
    run,
  };
}

/**
 * The `start_mission` tool (effectful) — the single up-front approval that begins a mission
 * (companion-missions.md §4, §5.1). The owner states a goal in an ordinary chat turn; the model
 * decomposes it and calls this tool with the plan + the machine predicate that drives the
 * wake; the shipped propose→approve gate (`tools/gate.ts`) holds it as a pending proposal and
 * EXITs the loop, so the owner confirms it in the Discord proposal card. On confirm the tool body
 * runs once: it arms the scheduler wake job (whose action @-mentions the companion bot so the
 * trigger's content is delivered, §1.2), creates the mission, and activates it — which suspends
 * the drive engine (an `active` mission is a query the motivation tick early-returns on).
 *
 * The mission is then the standing authorization: from here on effectful tools run ungated
 * (the gate's mission-mode bypass), so this is the ONLY approval the mission ever asks for.
 */

import type { ToolResult, TurnCtx } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { MissionService } from './mission-service.js';
import { readStringArg, type Tool, toolErrorMessage } from '../tools/tool.js';

/** The scheduler wake job a mission arms: poll `predicate` every `every`, then run `action`. */
export interface MissionJobSpec {
  /** The poll predicate CLI, e.g. `ibkr-cli query LITE le 810` (companion-missions.md §1.1). */
  readonly predicate: string;
  /** The poll interval, e.g. `1s` / `5m` (the scheduler `--every` value). */
  readonly every: string;
  /**
   * The action argv the scheduler runs when the predicate holds — carried as a pre-split
   * argv (not a shell string) so there is no quoting/`{{message}}`-escaping hazard. The
   * scheduler substitutes `{{message}}` per element (companion-missions.md §1.2).
   */
  readonly action: readonly string[];
}

/** Arms and cancels the scheduler jobs that drive a mission's wake (companion-missions.md §1.1). */
export interface MissionScheduler {
  /** Register a poll-until-condition job; resolves to the scheduler's job id. */
  arm(spec: MissionJobSpec): Promise<string>;
  /** Cancel a previously-armed job (compensation on a failed start, and on stop/complete). */
  cancel(jobId: string): Promise<void>;
}

/** The mission-channel + companion-bot ids needed to build the wake action (§1.2). */
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

/** Build the mission wake action argv: `discord-notify --channel <ch> --text "<@bot> {{message}}"`. */
function wakeAction(target: MissionWakeTarget): readonly string[] {
  return [
    'discord-notify',
    '--channel',
    target.missionChannelId,
    '--text',
    `<@${target.botUserId}> {{message}}`,
  ];
}

function error(content: string): ToolResult {
  return { name: RESULT_NAME, content, isError: true };
}

export function createStartMissionTool(options: StartMissionOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  return {
    name: RESULT_NAME,
    description:
      'Begin a long-running mission: register the monitoring job that wakes you and commit to ' +
      'the goal until its success criteria are met or you are told to stop. This starts autonomous ' +
      'background work — propose it for the user to approve; approval is the mission’s standing ' +
      'authorization (no further per-action approvals while it runs).',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The mission goal, in one sentence.' },
        plan: { type: 'string', description: 'How you will pursue the goal each time you wake.' },
        validationCriteria: {
          type: 'string',
          description:
            'The observable condition that means the mission is complete (when to stop).',
        },
        predicate: {
          type: 'string',
          description:
            'The machine poll predicate the scheduler evaluates, e.g. "ibkr-cli query LITE le 810".',
        },
        every: {
          type: 'string',
          description: 'How often to poll the predicate, e.g. "1s", "30s", "5m".',
        },
      },
      required: ['goal', 'plan', 'validationCriteria', 'predicate', 'every'],
      additionalProperties: false,
    },
    effectful: true,
    proposalSummary(args): string {
      const goal = readStringArg(args, 'goal');
      const predicate = readStringArg(args, 'predicate');
      const every = readStringArg(args, 'every');
      const head = goal ? `Start mission: ${goal}` : 'Start a mission';
      return predicate && every ? `${head} — monitor \`${predicate}\` every ${every}` : head;
    },
    async run(rawArgs, ctx: TurnCtx): Promise<ToolResult> {
      const goal = readStringArg(rawArgs, 'goal');
      const plan = readStringArg(rawArgs, 'plan');
      const validationCriteria = readStringArg(rawArgs, 'validationCriteria');
      const predicate = readStringArg(rawArgs, 'predicate');
      const every = readStringArg(rawArgs, 'every');
      if (!goal || !plan || !validationCriteria || !predicate || !every) {
        return error(
          'Error: start_mission needs non-empty goal, plan, validationCriteria, predicate, and every.',
        );
      }

      // One active mission per companion (companion-missions.md §3): refuse up front so the
      // common case never arms a job it can't activate. This is best-effort (the DB unique
      // index is the real backstop, caught at `activate` below with job-cancel compensation).
      // Residual gap: a crash in the window between `arm` and `activate` leaves the armed job
      // with no owning record — accepted for v1 (no durable outbox); `mission.stop` + the
      // scheduler's own job listing are the manual reconciliation path.
      if (await options.missions.hasActive(ctx.companionId)) {
        return error('Error: this companion is already on an active mission — stop it first.');
      }

      // The wake must be configured (mission channel + the companion bot's own id) before a
      // mission can be armed — the scheduler action @-mentions the bot to deliver the trigger.
      const target = await options.wakeConfig.forOwner(ctx.ownerId);
      if (!target) {
        return error(
          'Error: the mission wake is not configured (missing mission channel or bot id) — ' +
            'set it in Discord settings before starting a mission.',
        );
      }

      let jobId: string;
      try {
        jobId = await options.scheduler.arm({ predicate, every, action: wakeAction(target) });
      } catch (err) {
        logger.error('start_mission failed to arm the scheduler wake job', {
          operation: 'tool.start_mission',
          companionId: ctx.companionId,
          error: err,
        });
        return error(`Error arming the mission monitor: ${toolErrorMessage(err)}`);
      }

      try {
        const draft = await options.missions.createDraft(ctx.companionId, goal);
        const activated = await options.missions.activate(draft.id, {
          plan,
          validationCriteria,
          jobIds: [jobId],
          reportChannel: target.missionChannelId,
        });
        if (!activated) {
          // A fresh draft should always activate; if it didn't (a race lost the one-active
          // index), cancel the job we just armed rather than leave it firing with no mission.
          await options.scheduler.cancel(jobId).catch((cancelErr) => {
            logger.error('start_mission failed to cancel an orphaned wake job', {
              operation: 'tool.start_mission',
              companionId: ctx.companionId,
              jobId,
              error: cancelErr,
            });
          });
          return error('Error: could not activate the mission (another may have just started).');
        }
        return {
          name: RESULT_NAME,
          content:
            `Mission started: "${goal}". I’ll watch \`${predicate}\` every ${every} and act ` +
            `until ${validationCriteria}.`,
        };
      } catch (err) {
        logger.error('start_mission failed to create/activate the mission', {
          operation: 'tool.start_mission',
          companionId: ctx.companionId,
          jobId,
          error: err,
        });
        await options.scheduler.cancel(jobId).catch(() => undefined);
        return error(`Error starting the mission: ${toolErrorMessage(err)}`);
      }
    },
  };
}

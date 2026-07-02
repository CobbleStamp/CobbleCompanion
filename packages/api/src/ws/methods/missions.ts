import type { Logger, MissionRecord, MissionScheduler, MissionService } from '@cobble/core';
import {
  missionAdvanceSchema,
  missionCreateSchema,
  missionLifecycleSchema,
  type ChatStreamEvent,
  type MissionDto,
} from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import { overCapGuard } from '../../quota-guard.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, NotFoundError, OverCapError, parseParams } from './helpers.js';
import { emitAll, embodiedCompanion, leaseGuard, yieldRoom } from './turn-stream.js';

/**
 * The mission WS methods (companion-missions.md §3.4, §5.2). Two are
 * turn-producers — `mission.create` runs the planning turn that proposes `start_mission`, and
 * `mission.advance` runs the wake turn (a trigger or the owner messaging) — so they go through
 * the connection's serial chain (D2′) exactly like `messages.send`. `mission.list`/`mission.stop`
 * are plain request/response over the tested {@link MissionService}.
 *
 * Registered ONLY when both a {@link MissionService} and a {@link MissionScheduler} are wired
 * (a deployment without the scheduler-cli host doesn't expose missions), so every method below
 * can assume both are present.
 */
export function missionMethods(deps: AppDeps): WsMethods {
  const { missions, missionScheduler } = deps;
  if (!missions || !missionScheduler) {
    return {};
  }
  const { identity, embodiment, harness, quota, motivation, presence, logger } = deps;

  return {
    'mission.create': async (ctx, params) => {
      const { goal } = parseParams(missionCreateSchema, params, 'a mission goal is required');
      const {
        id: companionId,
        dto: companion,
        connectionId,
        claimSeq,
      } = await embodiedCompanion({ identity, embodiment }, ctx);
      presence.recordActivity(companionId, { connectionId, claimSeq });
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      // A normal turn seeded with the goal: the model decomposes it and calls `start_mission`
      // (effectful), which the approval gate holds as a proposal for the owner to confirm.
      const superseded = await ctx.connection.runSerial(() =>
        emitAll(
          ctx,
          harness.runTurn({
            companion,
            userContent: planningPrompt(goal),
            ownerId: ctx.userId,
            holdsLease: leaseGuard(embodiment, companionId, connectionId, claimSeq),
          }),
        ),
      );
      if (superseded) {
        yieldRoom(ctx, companionId);
      }
      return { done: true };
    },

    'mission.advance': async (ctx, params) => {
      const { event } = parseParams(missionAdvanceSchema, params, 'an event is required');
      const {
        id: companionId,
        dto: companion,
        connectionId,
        claimSeq,
      } = await embodiedCompanion({ identity, embodiment }, ctx);
      // Route to the single active mission (companion-missions.md §4). If there is none — a
      // stale/duplicate trigger, or one racing a just-issued `mission.stop` — do NOT burn a
      // stamina turn: the mission-retrieve arm would inject no context, the gate bypass would
      // be off, and nothing would be journaled. Skip cheaply instead.
      const active = await missions.findActive(companionId);
      if (!active) {
        logger.info('mission.advance with no active mission — skipping the turn', {
          operation: 'mission.advance',
          companionId,
        });
        return { done: true, skipped: 'no active mission' };
      }
      presence.recordActivity(companionId, { connectionId, claimSeq });
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      // The wake turn: the mission-retrieve arm injects goal/plan/journal + the gate's
      // mission-mode bypass runs effectful tools ungated. The report is journaled as findings.
      const superseded = await ctx.connection.runSerial(() =>
        emitAll(
          ctx,
          withMissionJournal(
            harness.runTurn({
              companion,
              userContent: event,
              ownerId: ctx.userId,
              holdsLease: leaseGuard(embodiment, companionId, connectionId, claimSeq),
            }),
            missions,
            active.id,
            event,
            logger,
          ),
        ),
      );
      if (superseded) {
        // The turn stood down mid-loop; nothing journaled. NOTE: a trigger-driven advance has
        // no client that re-runs it, so the wake event is dropped here — consistent with the
        // deferred reconnect-replay backstop (companion-missions.md §3.2, §5.4).
        yieldRoom(ctx, companionId);
      }
      return { done: true };
    },

    'mission.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const records = await missions.list(companionId);
      return { missions: records.map(toMissionDto) };
    },

    'mission.stop': async (ctx, params) => {
      const { missionId } = parseParams(missionLifecycleSchema, params, 'a mission id is required');
      const companionId = await companionOf(embodiment, ctx);
      const mission = await missions.get(missionId);
      // Tenancy: only the embodied companion's own missions are actionable.
      if (!mission || mission.companionId !== companionId) {
        throw new NotFoundError('no such mission');
      }
      // Cancel the wake jobs first so no trigger fires after the mission is gone; a cancel
      // failure is logged but never blocks the state transition (the mission still stops).
      await cancelJobs(missionScheduler, mission.jobIds, logger, missionId);
      const stopped = await missions.stop(missionId);
      // Leaving `active` re-enables drives on the next tick; nudge so it happens promptly.
      motivation.request(companionId);
      return { mission: stopped ? toMissionDto(stopped) : toMissionDto(mission) };
    },
  };
}

/** The seed message for a `mission.create` planning turn. */
function planningPrompt(goal: string): string {
  return (
    `I'd like you to take on a mission: "${goal}". Think about how you'd pursue it as a ` +
    `long-running background task, then call the start_mission tool with a concrete plan, the ` +
    `success criteria that tell you when it's complete, and the machine predicate + interval to ` +
    `monitor. If this isn't a good fit for a background mission, say so instead of starting one.`
  );
}

/**
 * Forward a mission wake turn's stream, capturing the spoken report and appending it to the
 * mission's journal as `findings` (v1 report-as-findings, companion-missions.md §3.4). A
 * superseded turn journals nothing — the live turn on the new connection owns that write.
 * The journal write is best-effort: a failure is logged, never surfaced into the turn.
 *
 * `missionId` is resolved by the caller (the active mission at turn start), so a mission that
 * changes status mid-turn still journals against the mission that was actually advanced.
 *
 * The manual drive (rather than `yield*`) is what lets us tap the `done` report; the
 * `try/finally` forwards an early `.return()` from the consumer (`emitAll` on a client abort)
 * into `inner`, so the harness generator's own `finally` — trace end, token debit, in-flight
 * LLM stream teardown — always runs, matching the delegation guarantee `yield*` would give.
 */
export async function* withMissionJournal(
  inner: AsyncGenerator<ChatStreamEvent, boolean>,
  missions: MissionService,
  missionId: string,
  event: string,
  logger: Logger,
): AsyncGenerator<ChatStreamEvent, boolean> {
  let report = '';
  let superseded = false;
  try {
    let next = await inner.next();
    while (!next.done) {
      const chunk = next.value;
      if (chunk.type === 'done') {
        report = chunk.message.content;
      }
      yield chunk;
      next = await inner.next();
    }
    superseded = next.value === true;
  } finally {
    // No-op once `inner` is already done; on an early abort it forwards the return so the
    // harness generator's `finally` runs. Best-effort — teardown must never throw out of here.
    await inner.return(false).catch(() => undefined);
  }
  // A superseded turn stood down without a completed reply — journal nothing.
  if (superseded) {
    return true;
  }
  try {
    await missions.recordJournal(missionId, {
      event,
      findings: report.trim().length > 0 ? report : null,
    });
  } catch (error) {
    logger.error('mission advance failed to journal the turn', {
      operation: 'mission.advance.journal',
      missionId,
      error,
    });
  }
  return false;
}

/** Cancel every wake job for a stopped mission (best-effort, each logged on failure). */
async function cancelJobs(
  scheduler: MissionScheduler,
  jobIds: readonly string[],
  logger: Logger,
  missionId: string,
): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await scheduler.cancel(jobId);
    } catch (error) {
      logger.error('failed to cancel a mission wake job', {
        operation: 'mission.stop.cancel',
        missionId,
        jobId,
        error,
      });
    }
  }
}

/** Project a stored mission record to the surface DTO (dates as ISO strings). */
function toMissionDto(record: MissionRecord): MissionDto {
  return {
    id: record.id,
    goal: record.goal,
    plan: record.plan,
    validationCriteria: record.validationCriteria,
    status: record.status,
    jobIds: record.jobIds,
    reportChannel: record.reportChannel,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

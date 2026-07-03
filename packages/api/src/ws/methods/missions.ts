import {
  reconcileMissionJobs,
  routeMissionAdvance,
  type Logger,
  type MissionJournalRecord,
  type MissionRecord,
  type MissionReconcileDeps,
  type MissionService,
} from '@cobble/core';
import {
  missionAdvanceSchema,
  missionJournalSchema,
  missionLifecycleSchema,
  type ChatStreamEvent,
  type MissionDto,
  type MissionJournalEntryDto,
} from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import { overCapGuard } from '../../quota-guard.js';
import type { WsCallContext, WsMethods } from '../dispatch.js';
import { companionOf, NotFoundError, OverCapError, parseParams } from './helpers.js';
import { emitAll, embodiedCompanion, leaseGuard, yieldRoom } from './turn-stream.js';

/**
 * The mission WS methods (companion-missions.md §5.2, §5.3). One is a turn-producer —
 * `mission.advance` runs the wake turn (a trigger or the owner messaging) — so it goes through
 * the connection's serial chain (D2′) exactly like `messages.send`. (Mission *creation* is
 * chat-initiated: the owner states the goal in an ordinary turn and the model proposes the
 * effectful `start_mission` — there is no separate create method.) `mission.list` /
 * `mission.journal` / `mission.stop` are plain request/response over the tested
 * {@link MissionService}.
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
  const reconcileDeps: MissionReconcileDeps = { missions, scheduler: missionScheduler, logger };

  /** Resolve a mission by id, tenancy-checked to the embodied companion. */
  const ownMission = async (ctx: WsCallContext, missionId: string): Promise<MissionRecord> => {
    const companionId = await companionOf(embodiment, ctx);
    const mission = await missions.get(missionId);
    if (!mission || mission.companionId !== companionId) {
      throw new NotFoundError('no such mission');
    }
    return mission;
  };

  return {
    'mission.advance': async (ctx, params) => {
      const { missionId, event } = parseParams(
        missionAdvanceSchema,
        params,
        'a mission id and an event are required',
      );
      const {
        id: companionId,
        dto: companion,
        connectionId,
        claimSeq,
      } = await embodiedCompanion({ identity, embodiment }, ctx);
      // Route by the NAMED mission (companion-missions.md §3.2): only this companion's active
      // mission earns a turn; an unknown/foreign/non-active id skips cheaply (no stamina, no
      // journal), reconciling its own stale wake jobs on the way out. The decision + the
      // reconcile live in `@cobble/core` so this handler stays thin (architecture-rules R1).
      const routing = await routeMissionAdvance(reconcileDeps, companionId, missionId);
      if (routing.kind === 'skip') {
        return { done: true, skipped: routing.reason };
      }
      const mission = routing.mission;
      presence.recordActivity(companionId, { connectionId, claimSeq });
      const overCap = await overCapGuard(quota, companionId);
      if (overCap) {
        throw new OverCapError(overCap);
      }
      // The wake turn: the mission-retrieve arm injects goal/plan/journal, and
      // `origin: 'mission'` + `missionId` are what the gate's turn-scoped mission-mode
      // bypass keys on — effectful tools run ungated in THIS turn only, and only while
      // THIS mission stays active (a stop of it re-gates the turn). Journaled as findings.
      const superseded = await ctx.connection.runSerial(() =>
        emitAll(
          ctx,
          withMissionJournal(
            harness.runTurn({
              companion,
              userContent: event,
              ownerId: ctx.userId,
              holdsLease: leaseGuard(embodiment, companionId, connectionId, claimSeq),
              origin: 'mission',
              missionId: mission.id,
            }),
            missions,
            mission.id,
            event,
            logger,
          ),
        ),
      );
      if (superseded) {
        // The turn stood down mid-loop; nothing journaled. NOTE: a trigger-driven advance has
        // no client that re-runs it, so the wake event is dropped here — consistent with the
        // deferred reconnect-replay backstop (companion-missions.md §3.2, §11).
        yieldRoom(ctx, companionId);
      }
      return { done: true };
    },

    'mission.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const records = await missions.list(companionId);
      return { missions: records.map(toMissionDto) };
    },

    'mission.journal': async (ctx, params) => {
      const { missionId, limit } = parseParams(
        missionJournalSchema,
        params,
        'a mission id is required',
      );
      const mission = await ownMission(ctx, missionId);
      const entries = await missions.recentJournal(mission.id, limit);
      return { entries: entries.map(toJournalEntryDto) };
    },

    'mission.stop': async (ctx, params) => {
      const { missionId } = parseParams(missionLifecycleSchema, params, 'a mission id is required');
      // Tenancy: only the embodied companion's own missions are actionable.
      const mission = await ownMission(ctx, missionId);
      // Stop is active-only (companion-missions.md §5.3): a `draft` is a mission mid-start
      // (arm→activate window) whose armed job isn't in `jobIds` yet — stopping it here would
      // flip its status without cancelling that job, and a terminal mission is already stopped.
      // Either way it's a no-op that returns the mission's current state unchanged.
      if (mission.status !== 'active') {
        return { mission: toMissionDto(mission) };
      }
      // Cancel the wake jobs first so no trigger fires after the mission is gone; the shared
      // reconcile keeps any failed cancel recorded (so a later stale firing retries it) and
      // never throws — the mission still stops even if the scheduler or the write is down.
      await reconcileMissionJobs(reconcileDeps, missionId, mission.jobIds);
      const stopped = await missions.stop(missionId);
      // Leaving `active` re-enables drives on the next tick; nudge so it happens promptly.
      motivation.request(mission.companionId);
      // `stop` returns null only when the mission raced to terminal between our read and the
      // write; re-fetch so the reply reports the true (terminal) status, never a stale `active`
      // snapshot. If even the re-read is gone (deleted), fall back to the pre-stop record.
      const current = stopped ?? (await missions.get(missionId)) ?? mission;
      return { mission: toMissionDto(current) };
    },
  };
}

/**
 * Forward a mission wake turn's stream, capturing the spoken report and appending it to the
 * mission's journal as `findings` (report-as-findings, companion-missions.md §5.2). A
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

/** Project a stored journal row to the surface DTO (dates as ISO strings). */
function toJournalEntryDto(record: MissionJournalRecord): MissionJournalEntryDto {
  return {
    id: record.id,
    missionId: record.missionId,
    event: record.event,
    findings: record.findings,
    prediction: record.prediction,
    decision: record.decision,
    turnAt: record.turnAt.toISOString(),
  };
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
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

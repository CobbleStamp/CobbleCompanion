/**
 * The propose→approve gate and the tool-call logger (architecture.md §4.4 / DoD).
 * `createApprovalGate` is the harness `beforeToolCall` hook: a read-only (or
 * unknown) call passes through; an effectful call is enqueued as a pending
 * proposal and BLOCKED, so the loop EXITs awaiting approval and nothing
 * consequential runs unconfirmed. `createLoggingAfterToolCall` is the
 * `afterToolCall` hook that records every executed call (the "every tool call is
 * logged" DoD).
 */

import { consoleLogger, type Logger } from '../logging.js';
import type { AfterToolCall, BeforeToolCall } from '../harness/hooks.js';
import { toProposalDto, type ProposalStore } from './proposal-store.js';
import type { ToolRegistry } from './registry.js';
import type { ToolCallLog } from './tool-call-log.js';

export function createApprovalGate(
  proposals: ProposalStore,
  registry: ToolRegistry,
  logger: Logger = consoleLogger,
  /**
   * Mission-mode bypass (companion-missions.md §6). When present, effectful tools run
   * UNGATED — but ONLY inside a mission turn (`ctx.origin === 'mission'`, a
   * `mission.advance` wake) AND while the mission driving THAT turn (`ctx.missionId`) is
   * still `active`: the mission is the standing authorization the user granted at start
   * (`start_mission`, the one up-front approval), scoped to the turns its own wake drives.
   * The check keys on the turn's specific mission, NOT "any active mission for the
   * companion" — otherwise a stop of the mission driving the turn would fail to re-gate it
   * whenever a second mission started in the same window (it would borrow the newcomer's
   * grant). Ordinary chat run while a mission is active stays fully gated. Omitted = every
   * effectful call is gated (the pre-missions behaviour). A narrow interface keeps the
   * coupling to the one check.
   */
  missions?: { isActive(missionId: string): Promise<boolean> },
): BeforeToolCall {
  return async (call, ctx) => {
    const tool = registry.get(call.name);
    // Read-only tools run freely; an unknown tool also passes (dispatch turns it
    // into an error result the model sees — never a silent block).
    if (!tool || !tool.effectful) {
      return call;
    }
    // Inside a mission turn, the propose→approve gate is suspended for effectful calls
    // (the mission is the grant, scoped to the turns its wake drives). The `isActive`
    // re-read — one cheap indexed read, only on an effectful call in a mission turn —
    // closes the stop-mid-turn race: a mission stopped while its advance turn is in flight
    // re-gates that turn's next effectful call. It keys on `ctx.missionId` (the mission
    // driving THIS turn), so stopping that mission re-gates it even if a different mission
    // for the same companion is active — no borrowing another mission's authorization.
    if (
      ctx.origin === 'mission' &&
      ctx.missionId !== undefined &&
      missions &&
      (await missions.isActive(ctx.missionId))
    ) {
      logger.info('effectful tool call allowed ungated inside a mission turn', {
        operation: 'gate.beforeToolCall',
        companionId: ctx.companionId,
        tool: call.name,
      });
      return call;
    }
    const summary = tool.proposalSummary ? tool.proposalSummary(call.args) : `Run "${call.name}"`;
    const record = await proposals.create(ctx.companionId, {
      toolName: call.name,
      toolArgs: call.args,
      ...(call.id !== undefined ? { toolCallId: call.id } : {}),
      summary,
    });
    logger.info('held an effectful tool call for approval', {
      operation: 'gate.beforeToolCall',
      companionId: ctx.companionId,
      tool: call.name,
      proposalId: record.id,
    });
    return { blocked: true, reason: summary, proposal: toProposalDto(record) };
  };
}

export function createLoggingAfterToolCall(
  toolCallLog: ToolCallLog,
  logger: Logger = consoleLogger,
): AfterToolCall {
  return async (result, call, ctx) => {
    // Best-effort: a logging hiccup must not break the turn (logging.md).
    try {
      await toolCallLog.record(ctx.companionId, call.name, call.args, result.content);
    } catch (error) {
      logger.error('failed to log tool call', {
        operation: 'gate.afterToolCall',
        companionId: ctx.companionId,
        tool: call.name,
        error,
      });
    }
    return result;
  };
}

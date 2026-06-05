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
): BeforeToolCall {
  return async (call, ctx) => {
    const tool = registry.get(call.name);
    // Read-only tools run freely; an unknown tool also passes (dispatch turns it
    // into an error result the model sees — never a silent block).
    if (!tool || !tool.effectful) {
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

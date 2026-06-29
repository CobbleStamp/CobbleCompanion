import {
  dispatchTool,
  type LeadStore,
  type Logger,
  type MemoryStore,
  type ProceduralStore,
  type ProposalRecord,
  type ProposalStore,
  type ToolCallLog,
  type ToolRegistry,
  type ToolResult,
} from '@cobble/core';
import type { MessageDto } from '@cobble/shared';

/**
 * The collaborators a proposal-confirm needs, narrowed to exactly the methods it uses
 * (Interface Segregation): claim the proposal, dispatch the approved tool, log the call,
 * record procedural memory + advance the originating lead, and append the outcome row.
 * `AppDeps` structurally satisfies this (with `logger` set to the per-connection logger),
 * so the WS handler builds it from its own deps; tests pass a hand-built object with fakes.
 */
export interface ConfirmProposalDeps {
  readonly proposals: Pick<ProposalStore, 'markResolved'>;
  readonly tools: ToolRegistry;
  readonly toolCallLog: Pick<ToolCallLog, 'record'>;
  readonly procedural: Pick<ProceduralStore, 'record'>;
  readonly leads: Pick<LeadStore, 'markStatus'>;
  readonly memory: Pick<MemoryStore, 'appendMessage'>;
  readonly logger: Logger;
}

export interface ConfirmProposalInput {
  readonly companionId: string;
  readonly ownerId: string;
  readonly proposalId: string;
}

/**
 * The outcome of a confirm attempt. **Total** — `confirmProposal` never throws for the
 * expected lost-claim case (`not_pending`), so the transport layer has a single branch
 * (mirrors the Result convention in discord-token-mint.ts). On success it carries the
 * claimed `proposal` (its `origin` decides whether the chat loop re-enters), the
 * `toolResult` (its `content` feeds `continueAfterApproval`; `isError` gates the
 * side-effects), and the appended `outcomeRow` (the `tool_step` the non-chat path emits).
 */
export type ConfirmProposalResult =
  | { readonly outcome: 'not_pending' }
  | {
      readonly outcome: 'confirmed';
      readonly proposal: ProposalRecord;
      readonly toolResult: ToolResult;
      readonly outcomeRow: MessageDto | null;
    };

const OPERATION = 'proposals.confirm';

/**
 * Execute an approved proposal end to end (architecture.md §4.4): atomically claim it
 * (pending→approved, so two racing confirms can't both run the action), dispatch the
 * effectful tool, then fan out the bookkeeping — audit-log the call, and on success
 * record procedural memory + advance the originating lead. Finally append the outcome as
 * a `tool_step` transcript row. The bookkeeping is best-effort: a failure there is logged
 * but never aborts the confirm (the action already ran; failures are data, §4.7). The
 * caller (the WS `proposals.confirm` handler) owns the transport concerns — fencing,
 * over-cap, and re-entering / closing the live stream off the returned result.
 */
export async function confirmProposal(
  deps: ConfirmProposalDeps,
  input: ConfirmProposalInput,
): Promise<ConfirmProposalResult> {
  const { proposals, tools, toolCallLog, procedural, leads, memory, logger } = deps;
  const { companionId, ownerId, proposalId } = input;

  // Atomic claim: only the call that flips pending→approved executes.
  const proposal = await proposals.markResolved(companionId, proposalId, 'approved');
  if (!proposal) {
    return { outcome: 'not_pending' };
  }
  const toolResult = await dispatchTool(
    tools,
    proposal.toolName,
    proposal.toolArgs,
    { companionId, ownerId },
    logger,
    proposal.toolCallId ?? undefined,
  );
  try {
    await toolCallLog.record(companionId, proposal.toolName, proposal.toolArgs, toolResult.content);
  } catch (error) {
    logger.error('failed to log approved tool call', {
      operation: `${OPERATION}.log`,
      companionId,
      proposalId,
      error,
    });
  }
  if (!toolResult.isError) {
    try {
      await procedural.record(companionId, proposal.summary, [proposal.toolName]);
    } catch (error) {
      logger.error('failed to record procedural memory', {
        operation: `${OPERATION}.procedural`,
        companionId,
        proposalId,
        error,
      });
    }
    await advanceIngested(leads, companionId, proposal.leadId, proposalId, logger);
  }
  let outcomeRow: MessageDto | null = null;
  try {
    outcomeRow = await memory.appendMessage(companionId, 'assistant', toolResult.content, {
      kind: 'tool_step',
      metadata: { toolName: proposal.toolName },
    });
  } catch (error) {
    logger.error('failed to record approved action row', {
      operation: `${OPERATION}.row`,
      companionId,
      proposalId,
      error,
    });
  }
  return { outcome: 'confirmed', proposal, toolResult, outcomeRow };
}

/** Advance an explore-origin lead to `ingested` (best-effort). */
async function advanceIngested(
  leads: Pick<LeadStore, 'markStatus'>,
  companionId: string,
  leadId: string | null,
  proposalId: string,
  logger: Logger,
): Promise<void> {
  if (!leadId) return;
  try {
    await leads.markStatus(companionId, leadId, 'ingested');
  } catch (error) {
    logger.error('failed to advance lead lifecycle', {
      operation: `${OPERATION}.advanceLead`,
      companionId,
      proposalId,
      leadId,
      error,
    });
  }
}

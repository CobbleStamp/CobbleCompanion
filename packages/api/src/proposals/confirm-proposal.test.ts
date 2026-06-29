/**
 * `confirmProposal` domain-service unit tests (the use case behind WS `proposals.confirm`).
 * Exercised with fakes, no transport: the atomic claim, tool dispatch, the success-only
 * side-effects (procedural + lead advance), the always-appended outcome row, and the
 * best-effort contract — a thrown collaborator is logged and swallowed, never aborting
 * the confirm (the action already ran). Transport concerns (fencing, streaming) are the
 * handler's and covered by the ws-method / phase3 tests.
 */

import { ToolRegistry, type Tool, type ToolResult } from '@cobble/core';
import type { MessageDto, ProposalOrigin } from '@cobble/shared';
import { describe, expect, it, vi } from 'vitest';
import { confirmProposal, type ConfirmProposalDeps } from './confirm-proposal.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const COMPANION = 'c1';
const OWNER = 'o1';
const PROPOSAL = '11111111-1111-1111-1111-111111111111';

/** A proposal row, with the fields the service reads (overridable per test). */
function proposalRecord(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROPOSAL,
    companionId: COMPANION,
    toolName: 'remember_url',
    toolArgs: { url: 'https://x.dev' },
    toolCallId: 'call_1',
    summary: 'Remember https://x.dev',
    status: 'approved' as const,
    leadId: null,
    origin: 'chat' as ProposalOrigin,
    createdAt: new Date(0),
    resolvedAt: new Date(0),
    ...over,
  };
}

/** A registry holding one fake tool that returns the given result for `toolName`. */
function registryWith(toolName: string, result: ToolResult): ToolRegistry {
  const tool: Tool = {
    name: toolName,
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    effectful: true,
    run: async () => result,
  };
  return new ToolRegistry([tool], silentLogger);
}

/** Build deps with spies; `markResolved` returns `proposal` (null → lost claim). */
function buildDeps(opts: {
  proposal: ReturnType<typeof proposalRecord> | null;
  toolResult?: ToolResult;
  overrides?: Partial<ConfirmProposalDeps>;
}): {
  deps: ConfirmProposalDeps;
  spies: {
    record: ReturnType<typeof vi.fn>;
    procedural: ReturnType<typeof vi.fn>;
    markStatus: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
  };
} {
  const toolResult = opts.toolResult ?? { name: 'remember_url', content: 'saved' };
  const record = vi.fn(async () => undefined);
  const procedural = vi.fn(async () => undefined);
  const markStatus = vi.fn(async () => undefined);
  const appendMessage = vi.fn(
    async (companionId: string, _role: string, content: string): Promise<MessageDto> => ({
      id: 'row1',
      companionId,
      role: 'assistant',
      content,
      kind: 'tool_step',
      sourceId: null,
      createdAt: new Date(0).toISOString(),
    }),
  );
  const deps: ConfirmProposalDeps = {
    proposals: { markResolved: async () => opts.proposal },
    tools: registryWith(opts.proposal?.toolName ?? 'remember_url', toolResult),
    toolCallLog: { record } as unknown as ConfirmProposalDeps['toolCallLog'],
    procedural: { record: procedural } as unknown as ConfirmProposalDeps['procedural'],
    leads: { markStatus } as unknown as ConfirmProposalDeps['leads'],
    memory: { appendMessage } as unknown as ConfirmProposalDeps['memory'],
    logger: silentLogger,
    ...opts.overrides,
  };
  return { deps, spies: { record, procedural, markStatus, appendMessage } };
}

const input = { companionId: COMPANION, ownerId: OWNER, proposalId: PROPOSAL };

describe('confirmProposal', () => {
  it('returns not_pending and runs nothing when the claim is lost', async () => {
    const { deps, spies } = buildDeps({ proposal: null });
    const result = await confirmProposal(deps, input);
    expect(result.outcome).toBe('not_pending');
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.appendMessage).not.toHaveBeenCalled();
  });

  it('claims, dispatches, logs, records procedural + advances the lead, and appends the row', async () => {
    const { deps, spies } = buildDeps({
      proposal: proposalRecord({ leadId: 'lead1' }),
      toolResult: { name: 'remember_url', content: 'saved it' },
    });
    const result = await confirmProposal(deps, input);

    expect(result.outcome).toBe('confirmed');
    if (result.outcome !== 'confirmed') return;
    expect(result.toolResult.content).toBe('saved it');
    expect(result.outcomeRow?.content).toBe('saved it');
    expect(spies.record).toHaveBeenCalledOnce();
    expect(spies.procedural).toHaveBeenCalledWith(COMPANION, 'Remember https://x.dev', [
      'remember_url',
    ]);
    expect(spies.markStatus).toHaveBeenCalledWith(COMPANION, 'lead1', 'ingested');
    expect(spies.appendMessage).toHaveBeenCalledOnce();
  });

  it('skips procedural + lead advance on a tool error, but still logs and appends the row', async () => {
    const { deps, spies } = buildDeps({
      proposal: proposalRecord({ leadId: 'lead1' }),
      toolResult: { name: 'remember_url', content: 'boom', isError: true },
    });
    const result = await confirmProposal(deps, input);

    expect(result.outcome).toBe('confirmed');
    expect(spies.record).toHaveBeenCalledOnce(); // the call is still audited
    expect(spies.procedural).not.toHaveBeenCalled();
    expect(spies.markStatus).not.toHaveBeenCalled();
    expect(spies.appendMessage).toHaveBeenCalledOnce(); // the outcome row always lands
  });

  it('does not advance a lead when the proposal has none (chat-origin)', async () => {
    const { deps, spies } = buildDeps({ proposal: proposalRecord({ leadId: null }) });
    await confirmProposal(deps, input);
    expect(spies.markStatus).not.toHaveBeenCalled();
  });

  it('swallows a thrown collaborator (best-effort) — the confirm still succeeds', async () => {
    const { deps } = buildDeps({ proposal: proposalRecord() });
    const throwingMemory = {
      appendMessage: async () => {
        throw new Error('db down');
      },
    } as unknown as ConfirmProposalDeps['memory'];
    const result = await confirmProposal({ ...deps, memory: throwingMemory }, input);
    // The action already ran; a failed transcript write must not abort the confirm.
    expect(result.outcome).toBe('confirmed');
    if (result.outcome !== 'confirmed') return;
    expect(result.outcomeRow).toBeNull();
  });
});

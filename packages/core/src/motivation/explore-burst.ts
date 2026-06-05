/**
 * Explore burst (Phase 4) — the one proactive behaviour shipped in v1: take the
 * next few `new` reading-list leads and propose remembering them, held for
 * approval. This is the exact logic Phase 3's `/explore` route ran on the user's
 * command, extracted so the motivation engine can run it on an idle tick. The
 * only difference is the proposal `origin`: `explore` when the user triggered it,
 * `autonomous` when the engine did (architecture.md §4.4–§4.5).
 *
 * v1 is deliberately cheap: it proposes leads without an LLM judgement pass; the
 * effectful ingest only runs (and only spends tokens) once the user approves.
 */

import type { ProposalOrigin } from '@cobble/shared';
import type { LeadStore } from '../tools/lead-store.js';
import type { ProposalRecord, ProposalStore } from '../tools/proposal-store.js';
import type { ToolRegistry } from '../tools/registry.js';

/** How many reading-list items one burst proposes by default (a bounded burst). */
export const DEFAULT_EXPLORE_BURST = 3;

export interface ExploreBurstDeps {
  readonly leads: LeadStore;
  readonly proposals: ProposalStore;
  readonly tools: ToolRegistry;
}

export interface ExploreBurstParams {
  readonly companionId: string;
  /** `explore` (user command) or `autonomous` (motivation engine). */
  readonly origin: ProposalOrigin;
  /** Max leads to propose this burst (bounded by the personality focus length). */
  readonly limit?: number;
}

/**
 * Propose remembering the next `new` leads (held for approval) and advance each
 * to `read`. Returns the created proposals (newest leads first). Nothing is
 * ingested here — the proposals only execute on confirmation.
 */
export async function runExploreBurst(
  deps: ExploreBurstDeps,
  params: ExploreBurstParams,
): Promise<readonly ProposalRecord[]> {
  const limit = params.limit ?? DEFAULT_EXPLORE_BURST;
  if (limit <= 0) {
    return [];
  }
  const ingest = deps.tools.get('ingest_source');
  const next = (await deps.leads.listByStatus(params.companionId, ['new'])).slice(0, limit);
  const created: ProposalRecord[] = [];
  for (const lead of next) {
    const summary = ingest?.proposalSummary
      ? ingest.proposalSummary({ url: lead.url })
      : `Read ${lead.url} into long-term memory`;
    const proposal = await deps.proposals.create(params.companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: lead.url },
      summary,
      // Carry the lead id so resolving the proposal closes its lifecycle
      // (approve→ingested, reject→discarded) — proposal.routes.ts.
      leadId: lead.id,
      origin: params.origin,
    });
    await deps.leads.markStatus(params.companionId, lead.id, 'read');
    created.push(proposal);
  }
  return created;
}

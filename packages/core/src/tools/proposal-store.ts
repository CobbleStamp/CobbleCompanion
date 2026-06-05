/**
 * The approval queue store (Phase 3, architecture.md §4.4). Persists effectful
 * tool calls the companion proposes, and resolves them exactly once: `markResolved`
 * is a conditional update gated on `status = 'pending'`, so two racing confirms
 * cannot both execute the same action (mirrors the deferred-job atomic claim).
 */

import { proposals, type Database } from '@cobble/db';
import type { ProposalDto, ProposalStatus } from '@cobble/shared';
import { and, desc, eq } from 'drizzle-orm';

export interface CreateProposalInput {
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly toolCallId?: string;
  readonly summary: string;
  /** The reading-list lead this proposal came from, if any (explore-origin). */
  readonly leadId?: string;
}

export interface ProposalRecord {
  readonly id: string;
  readonly companionId: string;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly toolCallId: string | null;
  readonly summary: string;
  readonly status: ProposalStatus;
  /** Originating lead id (explore-origin), or null for a chat-origin proposal. */
  readonly leadId: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface ProposalStore {
  /** Enqueue a pending proposal for an effectful call. */
  create(companionId: string, input: CreateProposalInput): Promise<ProposalRecord>;
  /** The companion's still-pending proposals, newest first (the approval queue). */
  listPending(companionId: string): Promise<readonly ProposalRecord[]>;
  /** A single proposal scoped to its companion, or null. */
  get(companionId: string, proposalId: string): Promise<ProposalRecord | null>;
  /**
   * Resolve a pending proposal to `approved`/`rejected`, returning the row only
   * if THIS call won the transition (it was still pending). A second call returns
   * null — the exactly-once guard the confirm route relies on.
   */
  markResolved(
    companionId: string,
    proposalId: string,
    status: 'approved' | 'rejected',
  ): Promise<ProposalRecord | null>;
}

export class DrizzleProposalStore implements ProposalStore {
  constructor(private readonly db: Database) {}

  async create(companionId: string, input: CreateProposalInput): Promise<ProposalRecord> {
    const [row] = await this.db
      .insert(proposals)
      .values({
        companionId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
        summary: input.summary,
      })
      .returning();
    if (!row) {
      throw new Error('failed to create proposal');
    }
    return toRecord(row);
  }

  async listPending(companionId: string): Promise<readonly ProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.companionId, companionId), eq(proposals.status, 'pending')))
      .orderBy(desc(proposals.createdAt));
    return rows.map(toRecord);
  }

  async get(companionId: string, proposalId: string): Promise<ProposalRecord | null> {
    const [row] = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, proposalId), eq(proposals.companionId, companionId)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async markResolved(
    companionId: string,
    proposalId: string,
    status: 'approved' | 'rejected',
  ): Promise<ProposalRecord | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ status, resolvedAt: new Date() })
      .where(
        and(
          eq(proposals.id, proposalId),
          eq(proposals.companionId, companionId),
          eq(proposals.status, 'pending'),
        ),
      )
      .returning();
    return row ? toRecord(row) : null;
  }
}

/** Project a stored proposal to the wire DTO (shared by the gate and the routes). */
export function toProposalDto(proposal: ProposalRecord): ProposalDto {
  return {
    id: proposal.id,
    toolName: proposal.toolName,
    summary: proposal.summary,
    status: proposal.status,
    createdAt: proposal.createdAt.toISOString(),
  };
}

type ProposalRow = typeof proposals.$inferSelect;

function toRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    toolName: row.toolName,
    toolArgs: (row.toolArgs ?? {}) as Record<string, unknown>,
    toolCallId: row.toolCallId,
    summary: row.summary,
    status: row.status,
    leadId: row.leadId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

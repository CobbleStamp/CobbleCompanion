import type { MessageDto, MessageKind, MessageMetadata, MessageRole } from '@cobble/shared';
import { type Database, messages } from '@cobble/db';
import { and, count, desc, eq, gt } from 'drizzle-orm';

/**
 * Extras when appending a transcript row beyond the plain `(role, content)`:
 * `sourceId` links an upload's chip/acknowledgement; `kind` + `metadata` carry
 * the rich-conversation data (tool steps, proposals, grounding citations) so the
 * transcript is the single source of truth for what the surface renders.
 */
export interface AppendOptions {
  readonly sourceId?: string;
  readonly kind?: MessageKind;
  readonly metadata?: MessageMetadata;
}

/**
 * A transcript turn with its monotonic `seq` and raw `createdAt` Date — the unit
 * the episodic consolidation pass (Phase 2) reflects over. Distinct from
 * `MessageDto` (the surface-facing shape, ISO-string time, no seq): consolidation
 * needs the seq to advance its cursor and the Date to time-anchor episodes.
 */
export interface TranscriptEntry {
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: Date;
}

/**
 * MemoryStore boundary (architecture.md invariant #2). The Phase 0 implementation
 * is the companion's single continuous transcript — the episodic-memory substrate.
 * A companion has exactly one lifelong conversation, so every message attaches
 * directly to the companion (no conversation/session entity). Later phases add
 * semantic (P1) and episodic (P2) implementations behind this same interface
 * without changing callers.
 */
export interface MemoryStore {
  /**
   * Append a turn to the transcript. `options` carries the optional source link
   * and the rich-conversation `kind`/`metadata`; omit it for an ordinary turn
   * (which records as a plain `message`).
   */
  appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
    options?: AppendOptions,
  ): Promise<MessageDto>;
  /** Most recent `limit` messages, returned oldest-first for prompt assembly. */
  getRecentMessages(companionId: string, limit: number): Promise<readonly MessageDto[]>;
  /**
   * A single message by id, scoped to its companion — `null` if it doesn't exist
   * or belongs to another companion. The ownership check the reactions route makes
   * before it lets a reaction attach to a message (companion-reactions.md §8).
   */
  getMessageById(companionId: string, messageId: string): Promise<MessageDto | null>;
  /**
   * Transcript turns with `seq > afterSeq`, oldest-first, capped at `limit` — the
   * window the episodic consolidation pass reflects over (Phase 2). Carries the
   * `seq` cursor unit and the raw `createdAt` Date for episode time-anchoring.
   */
  getMessagesSince(
    companionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TranscriptEntry[]>;
  /** Number of transcript messages the companion holds. */
  countMessages(companionId: string): Promise<number>;
}

export class TranscriptMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
    options?: AppendOptions,
  ): Promise<MessageDto> {
    const [row] = await this.db
      .insert(messages)
      .values({
        companionId,
        role,
        content,
        kind: options?.kind ?? 'message',
        metadata: options?.metadata ?? null,
        sourceId: options?.sourceId ?? null,
      })
      .returning();
    if (!row) {
      throw new Error('failed to append message');
    }
    return toMessageDto(row);
  }

  async getRecentMessages(companionId: string, limit: number): Promise<readonly MessageDto[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.companionId, companionId))
      .orderBy(desc(messages.seq))
      .limit(limit);
    // Re-sort oldest-first (by monotonic seq) for chronological prompt assembly.
    return rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(toMessageDto);
  }

  async getMessageById(companionId: string, messageId: string): Promise<MessageDto | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.companionId, companionId), eq(messages.id, messageId)))
      .limit(1);
    return row ? toMessageDto(row) : null;
  }

  async getMessagesSince(
    companionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TranscriptEntry[]> {
    // Consolidation reflects over the *conversation*; tool-step and proposal
    // rows are UI chrome, so they never become episodic memory.
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companionId, companionId),
          gt(messages.seq, afterSeq),
          eq(messages.kind, 'message'),
        ),
      )
      .orderBy(messages.seq)
      .limit(limit);
    return rows.map((row) => ({
      seq: row.seq,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
    }));
  }

  async countMessages(companionId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.companionId, companionId));
    return row?.value ?? 0;
  }
}

function toMessageDto(row: typeof messages.$inferSelect): MessageDto {
  return {
    id: row.id,
    companionId: row.companionId,
    role: row.role,
    content: row.content,
    kind: row.kind,
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
  };
}

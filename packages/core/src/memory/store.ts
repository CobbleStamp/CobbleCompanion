import type { MessageDto, MessageRole } from '@cobble/shared';
import { type Database, messages } from '@cobble/db';
import { count, desc, eq } from 'drizzle-orm';

/**
 * MemoryStore boundary (architecture.md invariant #2). The Phase 0 implementation
 * is the companion's single continuous transcript — the episodic-memory substrate.
 * A companion has exactly one lifelong conversation, so every message attaches
 * directly to the companion (no conversation/session entity). Later phases add
 * semantic (P1) and episodic (P2) implementations behind this same interface
 * without changing callers.
 */
export interface MemoryStore {
  appendMessage(companionId: string, role: MessageRole, content: string): Promise<MessageDto>;
  /** Most recent `limit` messages, returned oldest-first for prompt assembly. */
  getRecentMessages(companionId: string, limit: number): Promise<readonly MessageDto[]>;
  /** Number of transcript messages the companion holds. */
  countMessages(companionId: string): Promise<number>;
}

export class TranscriptMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
  ): Promise<MessageDto> {
    const [row] = await this.db
      .insert(messages)
      .values({ companionId, role, content })
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
    createdAt: row.createdAt.toISOString(),
  };
}

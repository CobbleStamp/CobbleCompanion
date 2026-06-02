import type { ConversationDto, MessageDto, MessageRole } from '@cobble/shared';
import { conversations, type Database, messages } from '@cobble/db';
import { desc, eq } from 'drizzle-orm';

/**
 * MemoryStore boundary (architecture.md invariant #2). The Phase 0 implementation
 * is the conversation transcript — the episodic-memory substrate. Later phases add
 * semantic (P1) and episodic (P2) implementations behind this same interface
 * without changing callers.
 */
export interface MemoryStore {
  createConversation(companionId: string): Promise<ConversationDto>;
  getConversation(id: string): Promise<ConversationDto | null>;
  appendMessage(conversationId: string, role: MessageRole, content: string): Promise<MessageDto>;
  /** Most recent `limit` messages, returned oldest-first for prompt assembly. */
  getRecentMessages(conversationId: string, limit: number): Promise<readonly MessageDto[]>;
}

export class TranscriptMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async createConversation(companionId: string): Promise<ConversationDto> {
    const [row] = await this.db.insert(conversations).values({ companionId }).returning();
    if (!row) {
      throw new Error('failed to create conversation');
    }
    return {
      id: row.id,
      companionId: row.companionId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getConversation(id: string): Promise<ConversationDto | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return row
      ? {
          id: row.id,
          companionId: row.companionId,
          createdAt: row.createdAt.toISOString(),
        }
      : null;
  }

  async appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
  ): Promise<MessageDto> {
    const [row] = await this.db
      .insert(messages)
      .values({ conversationId, role, content })
      .returning();
    if (!row) {
      throw new Error('failed to append message');
    }
    return toMessageDto(row);
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<readonly MessageDto[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.seq))
      .limit(limit);
    // Re-sort oldest-first (by monotonic seq) for chronological prompt assembly.
    return rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(toMessageDto);
  }
}

function toMessageDto(row: typeof messages.$inferSelect): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

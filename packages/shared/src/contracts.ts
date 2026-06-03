import { z } from 'zod';

/**
 * Surface ↔ core contracts. These types and schemas are the *only* thing that
 * crosses the surface/core boundary (architecture.md invariant #1). Every request
 * body is validated here before it reaches the core (security.md "validate at
 * boundaries").
 */

/** Role of a transcript message — the episodic-memory substrate (implementation.md §1). */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

// --- Entities (mirror the persisted rows, minus tenancy internals) ---

export interface CompanionDto {
  readonly id: string;
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly createdAt: string;
}

export interface MessageDto {
  readonly id: string;
  readonly companionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

// --- Memory snapshot (the read-only memory browser, companionmemory.md) ---

/**
 * A memory section that is designed but not yet built. The browser renders these
 * as "coming soon" panels so the full knowledge-base shape is visible before the
 * stores exist (semantic = P1, procedural = P3). See companionmemory.md.
 */
export interface PlannedMemorySection {
  readonly status: 'not_implemented';
  /** Phase that introduces this memory kind, for the browser to surface. */
  readonly plannedPhase: string;
}

/**
 * The episodic memory section — Phase 0's only real memory: the companion's
 * single continuous transcript (implementation.md §1). One companion holds one
 * lifelong conversation, so this is a single message stream, not a list.
 */
export interface EpisodicMemorySection {
  readonly status: 'available';
  readonly messageCount: number;
}

/**
 * A read-only snapshot of everything a companion "holds", grouped by memory kind
 * so new kinds slot in without reshaping the client (architecture.md invariant #2).
 */
export interface MemorySnapshotDto {
  readonly identity: CompanionDto;
  readonly episodic: EpisodicMemorySection;
  readonly semantic: PlannedMemorySection;
  readonly procedural: PlannedMemorySection;
}

// --- Request bodies (validated at the API boundary) ---

export const createCompanionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  form: z.string().trim().min(1).max(80),
  temperament: z.string().trim().min(1).max(280),
});
export type CreateCompanionBody = z.infer<typeof createCompanionSchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
});
export type SendMessageBody = z.infer<typeof sendMessageSchema>;

// --- Streaming protocol (Server-Sent Events for chat, architecture.md §4.6) ---

/** A single token delta streamed from the model as the assistant turn is produced. */
export interface StreamTokenEvent {
  readonly type: 'token';
  readonly value: string;
}

/** Terminal success event carrying the persisted assistant message. */
export interface StreamDoneEvent {
  readonly type: 'done';
  readonly message: MessageDto;
}

/** Terminal failure event — failures are data (architecture.md §4.7). */
export interface StreamErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

export type ChatStreamEvent = StreamTokenEvent | StreamDoneEvent | StreamErrorEvent;

// --- Generic API envelope (patterns.md "API Response Format") ---

export interface ApiError {
  readonly error: string;
}

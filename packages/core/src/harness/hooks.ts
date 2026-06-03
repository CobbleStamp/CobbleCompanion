import type { MessageRole } from '@cobble/shared';

/**
 * The harness's named extension points (architecture.md invariant #3,
 * implementation.md §2.1). Phase 0 registers passthrough/no-op defaults; later
 * phases supply real implementations WITHOUT changing the loop.
 */

export interface ContextBlock {
  readonly role: MessageRole;
  readonly content: string;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResult {
  readonly name: string;
  readonly content: string;
}

export interface TurnCtx {
  readonly companionId: string;
}

/** A loop ENTRY — a human turn (P0) or a proactive trigger (P4). */
export interface Entry {
  readonly kind: 'user' | 'proactive';
  readonly content: string;
}

/** Returned by beforeToolCall to BLOCK an effectful action → exit-to-approve (P3). */
export interface Block {
  readonly blocked: true;
  readonly reason: string;
}

// memory-retrieval hook — assembles prior context for a turn from the companion's
// single continuous transcript
export type RetrieveContext = (companionId: string) => Promise<readonly ContextBlock[]>;

// tool hooks — gate around every tool call (P3)
export type BeforeToolCall = (call: ToolCall, ctx: TurnCtx) => Promise<ToolCall | Block>;
export type AfterToolCall = (result: ToolResult, ctx: TurnCtx) => Promise<ToolResult>;

// initiation hook — produces a non-human ENTRY (P4)
export type Initiator = (companionId: string) => Promise<Entry | null>;

// --- Phase 0 default hooks (passthrough / no-op) ---

export const passthroughBeforeToolCall: BeforeToolCall = async (call) => call;
export const passthroughAfterToolCall: AfterToolCall = async (result) => result;
export const idleInitiator: Initiator = async () => null;

export function isBlock(value: ToolCall | Block): value is Block {
  return 'blocked' in value && value.blocked === true;
}

import type { Citation, MessageRole } from '@cobble/shared';

/**
 * The harness's named extension points (architecture.md invariant #3,
 * implementation.md §2.1). Phase 0 registers passthrough/no-op defaults; later
 * phases supply real implementations WITHOUT changing the loop.
 */

export interface ContextBlock {
  readonly role: MessageRole;
  readonly content: string;
  /**
   * Where this block came from, when it was retrieved from semantic memory
   * (P1). The harness surfaces these as the turn's citations; absent on plain
   * transcript blocks.
   */
  readonly provenance?: readonly Citation[];
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

/**
 * Input to the memory-retrieval hook. `userContent` is the current ENTRY's
 * text — query-dependent recall (P1 semantic memory embeds the question) needs
 * it; the P0 recency window ignores it. An object, so future fields stay
 * additive (implementation.md §2.1).
 */
export interface RetrieveParams {
  readonly companionId: string;
  readonly userContent: string;
}

// memory-retrieval hook — assembles prior context for a turn (P0: the recency
// window over the single continuous transcript; P1: + semantic recall)
export type RetrieveContext = (params: RetrieveParams) => Promise<readonly ContextBlock[]>;

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

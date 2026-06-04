/**
 * The tool abstraction (architecture.md §4.2/§4.4). A tool is a capability the
 * model can invoke mid-turn: read-only tools run freely; `effectful` tools are
 * the ones the propose→approve gate (P3) holds for user approval. Each tool owns
 * its own arg validation and turns failures into a result string (failures are
 * data, §4.7) rather than throwing into the loop.
 */

import type { ToolResult, TurnCtx } from '../harness/hooks.js';
import type { ToolDef } from '../llm/gateway.js';

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, advertised to the model via the gateway. */
  readonly parameters: Record<string, unknown>;
  /**
   * Whether running this tool has cost / commitment / outward side-effects. The
   * approval gate blocks an effectful call; a read-only tool runs immediately.
   */
  readonly effectful: boolean;
  /** Execute the call. Must resolve (errors become an error {@link ToolResult}). */
  run(args: Record<string, unknown>, ctx: TurnCtx): Promise<ToolResult>;
  /**
   * A short, user-facing description of what approving this call will do, shown
   * in the approval card. Only meaningful for effectful tools; a generic summary
   * is used when omitted.
   */
  proposalSummary?(args: Record<string, unknown>): string;
}

/** Project a tool to the wire shape the LLM gateway advertises to the provider. */
export function toToolDef(tool: Tool): ToolDef {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** A user-safe one-line message for a thrown error (never leak internals/stack). */
export function toolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}

/** Read a non-empty string argument, or null when absent/blank/not-a-string. */
export function readStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Read an absolute http(s) URL argument, or null when missing/malformed. */
export function readHttpUrlArg(args: Record<string, unknown>, key: string): string | null {
  const value = readStringArg(args, key);
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

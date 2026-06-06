/**
 * The MCP tool-retrieval arm (companion-tools.md §5) — a `RetrieveContext` arm
 * that surfaces a companion's *relevant connected* MCP tools as a system hint, so
 * the model reaches for the right acquired capability when a turn calls for it.
 * Mirrors the procedural arm (procedural-retrieve.ts): cheap keyword overlap (no
 * embeddings), grounding-only (no recency window), zero usage, and degrades to no
 * hint on failure — recall never breaks the conversation. The tools themselves are
 * already advertised via the per-companion registry (harness.ts resolveRegistry);
 * this arm is the *hint* that points at the fitting one.
 */

import { mcpToolName } from '../mcp/adapter.js';
import type { McpConnectionStore } from '../mcp/connection-store.js';
import type { Logger } from '../logging.js';
import { ZERO_USAGE } from '../usage.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

export interface ToolRetrieveOptions {
  readonly connections: McpConnectionStore;
  /** How many matching tools to surface as hints. */
  readonly topK?: number;
  readonly logger: Logger;
}

const DEFAULT_TOP_K = 3;

/** Tokenize to lowercase word stems (length ≥ 3) for cheap overlap scoring. */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length >= 3),
  );
}

/** One connected tool, flattened across the companion's servers, with its advertised name. */
interface ConnectedTool {
  readonly advertisedName: string;
  readonly description: string;
  /** name + description, the text scored against the turn. */
  readonly haystack: string;
}

/** Build the MCP tool-retrieval `RetrieveContext` arm (grounding-only; appends no recency). */
export function createToolRetrieveContext(options: ToolRetrieveOptions): RetrieveContext {
  const topK = options.topK ?? DEFAULT_TOP_K;

  return async ({ companionId, userContent }) => {
    try {
      const connections = await options.connections.list(companionId);
      const tools: ConnectedTool[] = connections
        // Only servers that connected cleanly expose callable tools.
        .filter((connection) => connection.status === 'connected')
        .flatMap((connection) =>
          connection.toolsSnapshot.map((tool) => ({
            advertisedName: mcpToolName(connection.serverRef, tool.name),
            description: tool.description,
            haystack: `${tool.name} ${tool.description}`,
          })),
        );
      if (tools.length === 0) {
        return { blocks: [], usage: ZERO_USAGE };
      }
      const queryWords = keywords(userContent);
      const matched = tools
        .map((tool) => ({ tool, overlap: overlapScore(queryWords, tool.haystack) }))
        .filter((entry) => entry.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, topK)
        .map((entry) => entry.tool);
      if (matched.length === 0) {
        return { blocks: [], usage: ZERO_USAGE };
      }
      return { blocks: [toHintBlock(matched)], usage: ZERO_USAGE };
    } catch (error) {
      // Recall never breaks the conversation — degrade this arm to no hint.
      options.logger.error('mcp tool recall failed; degrading to no hint', {
        operation: 'harness.toolRetrieve',
        companionId,
        error,
      });
      return { blocks: [], usage: ZERO_USAGE };
    }
  };
}

/** Count how many query keywords appear in a tool's name+description. */
function overlapScore(queryWords: Set<string>, haystack: string): number {
  let overlap = 0;
  for (const word of keywords(haystack)) {
    if (queryWords.has(word)) {
      overlap += 1;
    }
  }
  return overlap;
}

/** Render the matched tools as one system hint listing each by its advertised name. */
function toHintBlock(tools: readonly ConnectedTool[]): ContextBlock {
  const lines = tools.map((tool) => `- \`${tool.advertisedName}\`: ${tool.description}`).join('\n');
  return {
    role: 'system',
    content: `You have connected tools that may help with this — call one if it fits:\n${lines}`,
  };
}

/**
 * The `memory_search` tool (read-only): search the companion's own semantic
 * memory so a multi-step task can draw on what it already knows before reaching
 * out to the web. Reuses the Phase 1 hybrid store; embeds the query and degrades
 * to the lexical arm if embedding fails (recall never breaks the turn, §4.3).
 */

import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { SemanticSearchHit, SemanticSearchParams } from '../memory/semantic-store.js';
import { readStringArg, type Tool } from './tool.js';

/** The slice of the semantic store this tool needs (dependency inversion). */
export interface SemanticSearchPort {
  search(companionId: string, params: SemanticSearchParams): Promise<readonly SemanticSearchHit[]>;
}

const DEFAULT_TOP_K = 5;

export interface MemorySearchOptions {
  readonly semantic: SemanticSearchPort;
  readonly embeddings: EmbeddingGateway;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly topK?: number;
  readonly logger?: Logger;
}

export function createMemorySearchTool(options: MemorySearchOptions): Tool {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const logger = options.logger ?? consoleLogger;
  return {
    name: 'memory_search',
    description:
      "Search the companion's own long-term memory (everything it has read) for passages " +
      'relevant to a query. Read-only. Prefer this before fetching the web.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in memory.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    effectful: false,
    async run(rawArgs, ctx): Promise<ToolResult> {
      const query = readStringArg(rawArgs, 'query');
      if (query === null) {
        return { name: 'memory_search', content: 'Error: memory_search needs a "query".' };
      }
      // Degrade, don't fail: an embedding outage falls back to lexical-only
      // search (an empty vector skips the vector arm in the store).
      let queryEmbedding: readonly number[] = [];
      try {
        const { vectors } = await options.embeddings.embed({
          input: [query],
          model: options.embeddingModel,
          dimensions: options.embeddingDimensions,
        });
        queryEmbedding = vectors[0] ?? [];
      } catch (error) {
        logger.error('memory_search embedding failed; degrading to lexical-only', {
          operation: 'tool.memory_search',
          companionId: ctx.companionId,
          error,
        });
      }
      const hits = await options.semantic.search(ctx.companionId, {
        queryEmbedding,
        queryText: query,
        topK,
      });
      if (hits.length === 0) {
        return { name: 'memory_search', content: 'No matching passages in memory.' };
      }
      return { name: 'memory_search', content: hits.map(formatHit).join('\n\n') };
    },
  };
}

/** Render a hit as a provenance-tagged passage the model can ground an answer in. */
function formatHit(hit: SemanticSearchHit): string {
  const where = hit.chapterTitle ? `${hit.sourceTitle} — ${hit.chapterTitle}` : hit.sourceTitle;
  return `[${where}] ${hit.originalText}`;
}

/**
 * The Phase 1 RetrieveContext implementation — fills the harness's
 * memory-retrieval hook with grounded semantic recall (architecture.md §4.3)
 * WITHOUT touching the loop. Embeds the user's question, hybrid-searches the
 * companion's sections, and prepends each hit as a provenance-carrying system
 * block (verbatim text + a "From <source>…" preamble), followed by the recency
 * transcript window. Retrieval failures degrade to recency-only — a broken
 * embedding provider must not break the conversation.
 */

import type { Citation } from '@cobble/shared';
import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { Logger } from '../logging.js';
import type { SemanticMemoryStore, SemanticSearchHit } from '../memory/semantic-store.js';
import type { MemoryStore } from '../memory/store.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

export interface SemanticRetrieveOptions {
  readonly memory: MemoryStore;
  readonly semantic: SemanticMemoryStore;
  readonly embeddings: EmbeddingGateway;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  /** Sections recalled per turn. */
  readonly topK?: number;
  /** Recent transcript messages appended after the semantic blocks. */
  readonly recentLimit?: number;
  readonly logger: Logger;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_RECENT_LIMIT = 20;

/** Build the RetrieveContext hook combining semantic recall + recency window. */
export function createSemanticRetrieveContext(options: SemanticRetrieveOptions): RetrieveContext {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  return async ({ companionId, userContent }) => {
    const semanticBlocks = await retrieveSemanticBlocks(options, companionId, userContent, topK);
    const recent = await options.memory.getRecentMessages(companionId, recentLimit);
    return [
      ...semanticBlocks,
      ...recent.map((message): ContextBlock => ({ role: message.role, content: message.content })),
    ];
  };
}

async function retrieveSemanticBlocks(
  options: SemanticRetrieveOptions,
  companionId: string,
  userContent: string,
  topK: number,
): Promise<readonly ContextBlock[]> {
  try {
    const [queryEmbedding] = await options.embeddings.embed({
      input: [userContent],
      model: options.embeddingModel,
      dimensions: options.embeddingDimensions,
    });
    if (!queryEmbedding) {
      return [];
    }
    const hits = await options.semantic.search(companionId, {
      queryEmbedding,
      queryText: userContent,
      topK,
    });
    return hits.map(toContextBlock);
  } catch (error) {
    options.logger.error('semantic recall failed; degrading to recency-only context', {
      operation: 'harness.semanticRetrieve',
      companionId,
      error,
    });
    return [];
  }
}

/** Render one hit as a grounding block: locating preamble + verbatim passage. */
function toContextBlock(hit: SemanticSearchHit): ContextBlock {
  const location = [
    hit.chapterTitle ? `chapter "${hit.chapterTitle}"` : null,
    `paragraphs ${hit.paraStart}–${hit.paraEnd}`,
    hit.pageStart !== null
      ? `pages ${hit.pageStart}${hit.pageEnd !== null && hit.pageEnd !== hit.pageStart ? `–${hit.pageEnd}` : ''}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return {
    role: 'system',
    content:
      `From the user's source "${hit.sourceTitle}" (${location}; topic: ${hit.topicTitle}). ` +
      `Quote or cite it when you draw on it:\n${hit.originalText}`,
    provenance: [toCitation(hit)],
  };
}

function toCitation(hit: SemanticSearchHit): Citation {
  return {
    sourceId: hit.sourceId,
    sourceTitle: hit.sourceTitle,
    chapterTitle: hit.chapterTitle,
    topicTitle: hit.topicTitle,
    paraStart: hit.paraStart,
    paraEnd: hit.paraEnd,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
  };
}

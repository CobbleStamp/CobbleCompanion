/** The memory_search read-only tool: embed → hybrid search → provenance-tagged text. */

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import type { EmbeddingGateway, EmbeddingParams, EmbeddingResult } from '../embedding/gateway.js';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import type { SemanticSearchHit, SemanticSearchParams } from '../memory/semantic-store.js';
import { createMemorySearchTool, type SemanticSearchPort } from './memory-search.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

function hit(overrides: Partial<SemanticSearchHit> = {}): SemanticSearchHit {
  return {
    sectionId: 's1',
    sourceId: 'src1',
    sourceTitle: 'Peru Guide',
    chapterTitle: 'Food',
    topicTitle: 'Ceviche',
    originalText: 'Ceviche is cured in lime.',
    paraStart: 1,
    paraEnd: 1,
    pageStart: null,
    pageEnd: null,
    score: 0.9,
    ...overrides,
  };
}

/** A search port that records the params it saw and returns canned hits. */
function searchPort(hits: readonly SemanticSearchHit[]): SemanticSearchPort & {
  lastParams: SemanticSearchParams | null;
} {
  const port = {
    lastParams: null as SemanticSearchParams | null,
    async search(_companionId: string, params: SemanticSearchParams) {
      port.lastParams = params;
      return hits;
    },
  };
  return port;
}

const embedOpts = { embeddingModel: 'embed', embeddingDimensions: 8 };

describe('createMemorySearchTool', () => {
  it('is a read-only tool', () => {
    const tool = createMemorySearchTool({
      semantic: searchPort([]),
      embeddings: new FakeEmbeddingGateway(),
      ...embedOpts,
    });
    expect(tool.effectful).toBe(false);
  });

  it('embeds the query and formats hits with provenance', async () => {
    const port = searchPort([
      hit(),
      hit({ chapterTitle: null, sourceTitle: 'Lima Notes', originalText: 'Best at noon.' }),
    ]);
    const tool = createMemorySearchTool({
      semantic: port,
      embeddings: new FakeEmbeddingGateway(),
      ...embedOpts,
    });
    const result = await tool.run({ query: 'ceviche' }, ctx);
    expect(port.lastParams?.queryText).toBe('ceviche');
    expect(port.lastParams?.queryEmbedding.length).toBe(8);
    expect(result.content).toContain('[Peru Guide — Food] Ceviche is cured in lime.');
    expect(result.content).toContain('[Lima Notes] Best at noon.');
  });

  it('reports when nothing matches', async () => {
    const tool = createMemorySearchTool({
      semantic: searchPort([]),
      embeddings: new FakeEmbeddingGateway(),
      ...embedOpts,
    });
    expect((await tool.run({ query: 'x' }, ctx)).content).toBe('No matching passages in memory.');
  });

  it('degrades to lexical-only (empty embedding) when embedding fails', async () => {
    const port = searchPort([hit()]);
    const throwingEmbeddings: EmbeddingGateway = {
      async embed(_params: EmbeddingParams): Promise<EmbeddingResult> {
        throw new Error('embedding provider down');
      },
    };
    const tool = createMemorySearchTool({
      semantic: port,
      embeddings: throwingEmbeddings,
      logger: silentLogger,
      ...embedOpts,
    });
    const result = await tool.run({ query: 'ceviche' }, ctx);
    expect(port.lastParams?.queryEmbedding).toEqual([]);
    expect(result.content).toContain('Ceviche is cured in lime.');
  });

  it('rejects a missing query as an error result', async () => {
    const tool = createMemorySearchTool({
      semantic: searchPort([]),
      embeddings: new FakeEmbeddingGateway(),
      ...embedOpts,
    });
    expect((await tool.run({}, ctx)).content).toMatch(/needs a "query"/);
  });
});

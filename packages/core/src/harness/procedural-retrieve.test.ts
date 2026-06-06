/** Procedural retrieval-as-hint — surfaces relevant learned routines, degrades safely. */

import { describe, expect, it } from 'vitest';
import type { ProceduralStore, ProcedureRecord } from '../tools/procedural-store.js';
import { createProceduralRetrieveContext } from './procedural-retrieve.js';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

/** A fake procedural store returning a fixed list (fakes-over-mocks). */
function fakeStore(procedures: readonly Partial<ProcedureRecord>[]): ProceduralStore {
  const full: ProcedureRecord[] = procedures.map((p, i) => ({
    id: `p${i}`,
    title: p.title ?? '',
    steps: p.steps ?? [],
    createdAt: new Date(0),
  }));
  return {
    async record() {},
    async list(_companionId, limit) {
      return full.slice(0, limit);
    },
    async count() {
      return full.length;
    },
  };
}

describe('createProceduralRetrieveContext', () => {
  it('returns no hints when there are no procedures', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([]),
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'book a hotel in Cusco' });
    expect(result.blocks).toEqual([]);
  });

  it('surfaces a procedure whose title overlaps the user message', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([
        { title: 'book a hotel', steps: ['web_fetch', 'ingest_source'] },
        { title: 'summarize the news', steps: [] },
      ]),
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'can you book a hotel for Friday?' });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.content).toContain('book a hotel');
    expect(result.blocks[0]!.content).toContain('web_fetch → ingest_source');
    // A grounding-only arm — no recency, no token spend.
    expect(result.usage.totalTokens).toBe(0);
  });

  it('returns no hints when nothing overlaps', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([{ title: 'water the plants' }]),
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'tell me about Peru' });
    expect(result.blocks).toEqual([]);
  });

  it('caps the number of hints at topK by overlap score', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([
        { title: 'plan trip itinerary details' },
        { title: 'plan trip' },
        { title: 'plan' },
      ]),
      topK: 2,
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'plan trip itinerary' });
    expect(result.blocks).toHaveLength(2);
  });

  it('nudges proactive loading of a recalled routine’s missing tools', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([
        { title: 'book a hotel', steps: ['mcp__booking__reserve', 'web_fetch'] },
      ]),
      // Advisor reports the catalog tool that isn't equipped.
      loadAdvisor: {
        async suggestProactiveLoads(_companionId, steps) {
          expect(steps).toEqual(['mcp__booking__reserve', 'web_fetch']);
          return ['mcp__booking__reserve'];
        },
      },
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'book a hotel for Friday' });
    expect(result.blocks).toHaveLength(2); // the routine hint + the load nudge
    expect(result.blocks[1]!.content).toContain('load_tool');
    expect(result.blocks[1]!.content).toContain('mcp__booking__reserve');
  });

  it('adds no load nudge when nothing needs loading', async () => {
    const arm = createProceduralRetrieveContext({
      procedural: fakeStore([{ title: 'book a hotel', steps: ['web_fetch'] }]),
      loadAdvisor: {
        async suggestProactiveLoads() {
          return []; // all in hand / not loadable
        },
      },
      logger: silentLogger,
    });
    const result = await arm({ companionId: 'c', userContent: 'book a hotel' });
    expect(result.blocks).toHaveLength(1); // just the routine hint
  });

  it('degrades to no hints when the store throws', async () => {
    const broken: ProceduralStore = {
      async record() {},
      async list() {
        throw new Error('db down');
      },
      async count() {
        return 0;
      },
    };
    const arm = createProceduralRetrieveContext({ procedural: broken, logger: silentLogger });
    const result = await arm({ companionId: 'c', userContent: 'anything' });
    expect(result.blocks).toEqual([]);
  });
});

/**
 * Tests for the semantic memory store: layer CRUD, hybrid (vector + lexical)
 * retrieval with provenance, metadata filters, RRF fusion, jobs, and counts —
 * against the real in-memory PGlite database with pgvector loaded.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import {
  combineHits,
  DrizzleSemanticMemoryStore,
  type SemanticSearchHit,
} from './semantic-store.js';

const gateway = new FakeEmbeddingGateway();

async function embedOne(text: string): Promise<readonly number[]> {
  const [vector] = await gateway.embed({
    input: [text],
    model: 'fake',
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return vector!;
}

describe('combineHits (reciprocal-rank fusion)', () => {
  function hit(sectionId: string): { hit: Omit<SemanticSearchHit, 'score'> } {
    return {
      hit: {
        sectionId,
        sourceId: 's',
        sourceTitle: 'Peru book',
        chapterTitle: null,
        topicTitle: 't',
        originalText: 'text',
        paraStart: 1,
        paraEnd: 1,
        pageStart: null,
        pageEnd: null,
      },
    };
  }

  it('ranks a section found by both arms above single-arm sections', () => {
    const fused = combineHits([hit('both'), hit('vec-only')], [hit('both'), hit('lex-only')], 10);
    expect(fused[0]?.sectionId).toBe('both');
    expect(fused).toHaveLength(3);
  });

  it('deduplicates by section and respects topK', () => {
    const fused = combineHits([hit('a'), hit('b'), hit('c')], [hit('a')], 2);
    expect(fused).toHaveLength(2);
    expect(fused[0]?.sectionId).toBe('a');
  });

  it('returns empty for empty inputs', () => {
    expect(combineHits([], [], 5)).toEqual([]);
  });
});

describe('DrizzleSemanticMemoryStore', () => {
  let store: DrizzleSemanticMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;
  let otherCompanionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleSemanticMemoryStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    const other = await identity.createCompanion(user.id, {
      name: 'Cobble',
      form: 'dog',
      temperament: 'playful',
    });
    otherCompanionId = other.id;
  });

  afterEach(async () => {
    await close();
  });

  /** Seed one source with one embedded section; returns ids. */
  async function seedSection(
    text: string,
    options: { companion?: string; title?: string; topic?: string } = {},
  ): Promise<{ sourceId: string; sectionId: string }> {
    const owner = options.companion ?? companionId;
    const source = await store.createSource(owner, {
      kind: 'note',
      title: options.title ?? 'Peru: A Culinary History',
      rawText: text,
    });
    const [section] = await store.insertSections(owner, source.id, [
      {
        topicTitle: options.topic ?? 'a topic',
        originalText: text,
        paraStart: 1,
        paraEnd: 2,
        ord: 0,
      },
    ]);
    await store.setSectionEmbedding(section!.id, await embedOne(text));
    return { sourceId: source.id, sectionId: section!.id };
  }

  it('creates and lists sources with verbatim text retrievable', async () => {
    const source = await store.createSource(companionId, {
      kind: 'pdf',
      title: 'Peru history',
      origin: 'peru.pdf',
      rawText: 'the original book text',
      byteSize: 1234,
    });

    const listed = await store.listSources(companionId);
    expect(listed.map((s) => s.id)).toEqual([source.id]);
    expect(await store.getSourceText(companionId, source.id)).toBe('the original book text');
    // Owner-scoped: another companion cannot read it.
    expect(await store.getSourceText(otherCompanionId, source.id)).toBeNull();
  });

  it('stores sections verbatim with provenance fields and enrichment updates', async () => {
    const { sourceId, sectionId } = await seedSection('Pizarro founded Lima in 1535.');
    await store.setSectionContextHeader(sectionId, '[Peru history, ch. 3 — the conquest]');

    const sectionList = await store.listSectionsBySource(companionId, sourceId);
    expect(sectionList).toHaveLength(1);
    expect(sectionList[0]?.originalText).toBe('Pizarro founded Lima in 1535.');
    expect(sectionList[0]?.contextHeader).toBe('[Peru history, ch. 3 — the conquest]');
    expect(sectionList[0]?.paraStart).toBe(1);
  });

  it('finds the semantically identical section first via the vector arm', async () => {
    const { sectionId } = await seedSection('ceviche history in Lima');
    await seedSection('train schedules in Cusco');

    const hits = await store.search(companionId, {
      queryEmbedding: await embedOne('ceviche history in Lima'),
      queryText: 'zzz-no-lexical-match',
      topK: 1,
    });

    expect(hits[0]?.sectionId).toBe(sectionId);
    expect(hits[0]?.sourceTitle).toBe('Peru: A Culinary History');
  });

  it('finds keyword matches via the lexical arm even without an embedding match', async () => {
    const { sectionId } = await seedSection('The ceviche tradition began on the coast.');
    await seedSection('Trains to Machu Picchu leave early.');

    const hits = await store.search(companionId, {
      // Embedding of an unrelated string: the vector arm is uninformative.
      queryEmbedding: await embedOne('completely unrelated query text'),
      queryText: 'ceviche',
      topK: 2,
    });

    expect(hits.some((h) => h.sectionId === sectionId)).toBe(true);
  });

  it('applies the sourceId metadata filter', async () => {
    const peru = await seedSection('Lima cuisine notes', { title: 'Food book' });
    await seedSection('Lima cuisine notes', { title: 'Other book' });

    const hits = await store.search(companionId, {
      queryEmbedding: await embedOne('Lima cuisine notes'),
      queryText: 'Lima cuisine',
      topK: 10,
      filters: { sourceId: peru.sourceId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceId).toBe(peru.sourceId);
  });

  it('applies the entity filter through the fact overlay', async () => {
    // Section text never names Pizarro — only the fact overlay does (the
    // unresolved-pronoun case the overlay exists to compensate).
    const target = await seedSection('He then moved the capital there in 1535.');
    await seedSection('Llamas graze in the highlands.');
    await store.insertFacts(companionId, [
      {
        sectionId: target.sectionId,
        factType: 'event',
        subject: 'Pizarro',
        predicate: 'founded',
        object: 'Lima',
        confidence: 0.9,
      },
    ]);

    const hits = await store.search(companionId, {
      queryEmbedding: await embedOne('unrelated'),
      queryText: 'capital',
      topK: 10,
      filters: { entity: 'pizarro' },
    });

    expect(hits.map((h) => h.sectionId)).toEqual([target.sectionId]);
  });

  it('scopes retrieval to the companion (tenancy invariant)', async () => {
    await seedSection('ceviche history in Lima', { companion: otherCompanionId });

    const hits = await store.search(companionId, {
      queryEmbedding: await embedOne('ceviche history in Lima'),
      queryText: 'ceviche',
      topK: 10,
    });

    expect(hits).toHaveLength(0);
  });

  it('tracks the ingestion job lifecycle and counts', async () => {
    const source = await store.createSource(companionId, {
      kind: 'pdf',
      title: 'Peru history',
      rawText: 'text',
    });
    const job = await store.createJob(companionId, source.id);
    expect(job.status).toBe('queued');

    await store.updateJob(job.id, { status: 'embedding', sectionsTotal: 4, sectionsDone: 2 });
    const [updated] = await store.listJobs(companionId);
    expect(updated?.status).toBe('embedding');
    expect(updated?.sectionsDone).toBe(2);

    await store.updateJob(job.id, { status: 'failed', error: 'could not parse PDF' });
    const [failed] = await store.listJobs(companionId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('could not parse PDF');

    await seedSection('a section');
    const counts = await store.counts(companionId);
    expect(counts.sources).toBe(2);
    expect(counts.sections).toBe(1);
  });
});

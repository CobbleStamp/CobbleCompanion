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
  const {
    vectors: [vector],
  } = await gateway.embed({
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

  it('assigns the hand-computed RRF score 2/61 to a rank-0 hit in both arms', () => {
    // RRF score = Σ 1/(60 + rank + 1); rank 0 in both arms → 1/61 + 1/61.
    const fused = combineHits([hit('both')], [hit('both')], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 12);
  });

  it('assigns the hand-computed RRF score 1/61 to a rank-0 hit in one arm only', () => {
    const fused = combineHits([hit('vec-only')], [], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
  });

  it('orders strictly by fused score: both-arms (2/61) above single-arm (1/62)', () => {
    // `both` is rank 0 in each arm → 1/61 + 1/61 = 2/61. `vec` and `lex` each
    // sit at rank 1 (the rank-0 slot is taken by `both`) in one arm → 1/62.
    const fused = combineHits([hit('both'), hit('vec')], [hit('both'), hit('lex')], 10);
    expect(fused[0]?.sectionId).toBe('both');
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 12);
    // The two single-arm hits both score 1/62 and trail `both`; assert their
    // shared score and set-membership (their relative order is the tie case).
    const rest = fused.slice(1);
    expect(rest.map((h) => h.sectionId).sort()).toEqual(['lex', 'vec']);
    for (const h of rest) {
      expect(h.score).toBeCloseTo(1 / 62, 12);
    }
  });

  it('keeps both members of a score tie, with the non-tied head ordered first', () => {
    // `top` is rank 0 in both arms (2/61); `a` and `b` each sit at rank 1 in a
    // different arm (1/62 each) — a genuine score tie. The head order is
    // deterministic (top first); the tied pair's relative order follows the
    // sort's behavior for equal keys, so assert membership for the pair and
    // exact position only for the unambiguous head.
    const fused = combineHits([hit('top'), hit('a')], [hit('top'), hit('b')], 10);
    expect(fused).toHaveLength(3);
    expect(fused[0]?.sectionId).toBe('top');
    const tied = fused.slice(1).map((h) => h.sectionId);
    expect(tied.sort()).toEqual(['a', 'b']);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 12);
    expect(fused[2]?.score).toBeCloseTo(1 / 62, 12);
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

  it('skips the vector arm for an empty query embedding but still returns lexical hits', async () => {
    const { sectionId } = await seedSection('The ceviche tradition began on the coast.');
    await seedSection('Trains to Machu Picchu leave early.');

    // Empty embedding (provider down / degraded): the vector arm is skipped
    // entirely, yet the lexical arm still answers.
    const hits = await store.search(companionId, {
      queryEmbedding: [],
      queryText: 'ceviche',
      topK: 5,
    });

    expect(hits.map((h) => h.sectionId)).toContain(sectionId);
  });

  it('returns a vector hit even when the query text has zero FTS matches', async () => {
    const { sectionId } = await seedSection('ceviche history in Lima');

    // Query text matches nothing lexically, but the vector arm finds the
    // semantically identical section.
    const hits = await store.search(companionId, {
      queryEmbedding: await embedOne('ceviche history in Lima'),
      queryText: 'zzzznomatchtoken',
      topK: 5,
    });

    expect(hits.map((h) => h.sectionId)).toEqual([sectionId]);
  });

  it('returns no hits when both arms are empty', async () => {
    await seedSection('ceviche history in Lima');

    const hits = await store.search(companionId, {
      // Empty embedding skips the vector arm; the query text matches nothing.
      queryEmbedding: [],
      queryText: 'zzzznomatchtoken',
      topK: 5,
    });

    expect(hits).toEqual([]);
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

  it('lists deferred jobs with owner + held parse, and clears on resume', async () => {
    const source = await store.createSource(companionId, {
      kind: 'note',
      title: 'Parked note',
      rawText: 'held',
    });
    const job = await store.createJob(companionId, source.id);
    await store.updateJob(job.id, {
      status: 'deferred',
      parsedDoc: { rawText: 'held', paragraphs: [{ ord: 1, text: 'held' }] },
    });

    const deferred = await store.listDeferredJobs();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.jobId).toBe(job.id);
    expect(deferred[0]!.sourceTitle).toBe('Parked note');
    expect(deferred[0]!.parsedDoc.paragraphs[0]!.text).toBe('held');

    await store.updateJob(job.id, { status: 'segmenting', parsedDoc: null });
    expect(await store.listDeferredJobs()).toHaveLength(0);
  });

  it('fails interrupted jobs on restart but spares deferred and terminal ones', async () => {
    const make = async (status: 'parsing' | 'segmenting' | 'deferred' | 'done') => {
      const source = await store.createSource(companionId, {
        kind: 'note',
        title: status,
        rawText: '',
      });
      const job = await store.createJob(companionId, source.id);
      await store.updateJob(job.id, { status });
      return job.id;
    };
    const parsing = await make('parsing');
    const segmenting = await make('segmenting');
    const deferred = await make('deferred');
    const done = await make('done');

    const failedCount = await store.failInterruptedJobs();
    expect(failedCount).toBe(2);

    const byId = new Map((await store.listJobs(companionId)).map((j) => [j.id, j.status]));
    expect(byId.get(parsing)).toBe('failed');
    expect(byId.get(segmenting)).toBe('failed');
    expect(byId.get(deferred)).toBe('deferred'); // resumable — spared
    expect(byId.get(done)).toBe('done'); // terminal — spared
  });

  it('replaces a source’s prior sections and their facts on re-ingestion', async () => {
    // A first run inserts two sections, one carrying a fact.
    const source = await store.createSource(companionId, {
      kind: 'note',
      title: 'Re-read me',
      rawText: 'first pass text',
    });
    const firstPass = await store.insertSections(companionId, source.id, [
      { topicTitle: 'one', originalText: 'alpha', paraStart: 1, paraEnd: 1, ord: 0 },
      { topicTitle: 'two', originalText: 'beta', paraStart: 2, paraEnd: 2, ord: 1 },
    ]);
    await store.insertFacts(companionId, [
      { sectionId: firstPass[0]!.id, factType: 'event', subject: 'a', object: 'b' },
    ]);
    expect((await store.counts(companionId)).sections).toBe(2);
    expect((await store.counts(companionId)).facts).toBe(1);

    // A second run for the SAME source replaces — not appends — the prior set,
    // and the orphaned facts cascade away with the deleted sections.
    const secondPass = await store.insertSections(companionId, source.id, [
      { topicTitle: 'only', originalText: 'gamma', paraStart: 1, paraEnd: 1, ord: 0 },
    ]);
    const remaining = await store.listSectionsBySource(companionId, source.id);
    expect(remaining.map((s) => s.id)).toEqual([secondPass[0]!.id]);
    expect(remaining.map((s) => s.originalText)).toEqual(['gamma']);
    expect((await store.counts(companionId)).sections).toBe(1);
    expect((await store.counts(companionId)).facts).toBe(0);
  });

  it('claims a deferred job exactly once', async () => {
    const source = await store.createSource(companionId, {
      kind: 'note',
      title: 'Parked',
      rawText: 'held',
    });
    const job = await store.createJob(companionId, source.id);
    await store.updateJob(job.id, { status: 'deferred' });

    // The first claim wins and flips the job out of `deferred`; a racing second
    // claim sees a non-deferred job and loses, so it is never resumed twice.
    expect(await store.claimDeferredJob(job.id)).toBe(true);
    expect(await store.claimDeferredJob(job.id)).toBe(false);
    const [claimed] = await store.listJobs(companionId);
    expect(claimed?.status).toBe('queued');
  });

  it('refuses to claim a job that is not deferred', async () => {
    const source = await store.createSource(companionId, {
      kind: 'note',
      title: 'Active',
      rawText: 'x',
    });
    const job = await store.createJob(companionId, source.id); // status: 'queued'
    expect(await store.claimDeferredJob(job.id)).toBe(false);
  });

  it('deletes a source within its companion scope, cascading its job', async () => {
    const source = await store.createSource(companionId, {
      kind: 'note',
      title: 'Doomed',
      rawText: 'x',
    });
    await store.createJob(companionId, source.id);

    // Another owner cannot delete it.
    expect(await store.deleteSource(otherCompanionId, source.id)).toBe(false);
    expect(await store.listSources(companionId)).toHaveLength(1);

    // The owner can; the job cascades away with the source.
    expect(await store.deleteSource(companionId, source.id)).toBe(true);
    expect(await store.listSources(companionId)).toHaveLength(0);
    expect(await store.listJobs(companionId)).toHaveLength(0);
  });
});

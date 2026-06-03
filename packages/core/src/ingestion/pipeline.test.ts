/**
 * End-to-end ingestion pipeline tests against the real PGlite-backed store:
 * note → parse → segment → enrich → embed → done, with verbatim sections,
 * provenance-linked facts, retrievability, and the failure path.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { LlmGateway, LlmStreamParams } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { IngestionPipeline } from './pipeline.js';

const silentLogger: Logger = { error: () => undefined, info: () => undefined };

/** LLM fake returning one scripted response per call, in order (we own the seam). */
class ScriptedLlmGateway implements LlmGateway {
  readonly calls: LlmStreamParams[] = [];
  private next = 0;

  constructor(private readonly responses: readonly string[]) {}

  async *stream(params: LlmStreamParams): AsyncIterable<string> {
    this.calls.push(params);
    yield this.responses[Math.min(this.next++, this.responses.length - 1)]!;
  }
}

const NOTE_TEXT = [
  'Pizarro arrived on the Peruvian coast.',
  'He then moved the capital there in 1535.',
  'Ceviche is cured with lime juice.',
  'It is served along the coast of Lima.',
].join('\n\n');

const SEGMENT_RESPONSE =
  '{"sections":[{"topic":"The conquest","start":1,"end":2},{"topic":"Coastal cuisine","start":3,"end":4}]}';
const ENRICH_CONQUEST =
  '{"context":"[Peru notes — Pizarro founds Lima as capital]","facts":[{"type":"event","subject":"Pizarro","predicate":"founded","object":"Lima","confidence":0.9}]}';
const ENRICH_CUISINE =
  '{"context":"[Peru notes — ceviche, lime-cured, Lima coast]","facts":[{"type":"attribute","subject":"ceviche","predicate":"cured with","object":"lime juice"}]}';

describe('IngestionPipeline', () => {
  let semantic: DrizzleSemanticMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;
  const embeddings = new FakeEmbeddingGateway();

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    semantic = new DrizzleSemanticMemoryStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  function makePipeline(llm: LlmGateway, useContextHeader = false): IngestionPipeline {
    return new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader,
      logger: silentLogger,
    });
  }

  async function seedSourceAndJob(): Promise<{ sourceId: string; jobId: string }> {
    const source = await semantic.createSource(companionId, {
      kind: 'note',
      title: 'Peru notes',
      rawText: '',
    });
    const job = await semantic.createJob(companionId, source.id);
    return { sourceId: source.id, jobId: job.id };
  }

  it('runs a note through all stages to done, storing verbatim sections + facts', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
    expect(job?.sectionsTotal).toBe(2);
    expect(job?.sectionsDone).toBe(2);

    // Canonical text persisted; sections are verbatim paragraph slices.
    expect(await semantic.getSourceText(companionId, sourceId)).toBe(NOTE_TEXT);
    const sections = await semantic.listSectionsBySource(companionId, sourceId);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.originalText).toBe(
      'Pizarro arrived on the Peruvian coast.\n\nHe then moved the capital there in 1535.',
    );
    expect(sections[0]?.paraStart).toBe(1);
    expect(sections[0]?.paraEnd).toBe(2);
    expect(sections[0]?.contextHeader).toContain('Pizarro founds Lima');

    // Facts carry section provenance; entity-filtered retrieval finds the
    // pronoun-only section through the overlay.
    const hits = await semantic.search(companionId, {
      queryEmbedding: await embedText(sections[0]!.originalText),
      queryText: 'capital',
      topK: 5,
      filters: { entity: 'Pizarro' },
    });
    expect(hits.map((h) => h.sectionId)).toEqual([sections[0]!.id]);
    expect(hits[0]?.sourceTitle).toBe('Peru notes');

    // Embeddings landed: exact-text query retrieves its own section first.
    const vectorHits = await semantic.search(companionId, {
      queryEmbedding: await embedText(sections[1]!.originalText),
      queryText: 'zzz-nolexical',
      topK: 1,
    });
    expect(vectorHits[0]?.sectionId).toBe(sections[1]!.id);
  });

  it('prefixes the context header onto the embedding input when enabled', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, true).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    expect(embeddings.lastParams?.input[0]).toMatch(/^\[Peru notes — /);
    expect(embeddings.lastParams?.input[0]).toContain('Pizarro arrived on the Peruvian coast.');
  });

  it('marks the job failed with a user-safe error on a broken payload', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Broken PDF',
      payload: { kind: 'pdf', bytes: new TextEncoder().encode('not a pdf') },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/could not finish reading/);
    // No internal detail leaks into the user-safe message.
    expect(job?.error).not.toMatch(/pdf\.js|stack|TypeError/i);
  });

  it('refuses links to private/internal addresses (SSRF guard) without fetching', async () => {
    const fetchSpy: typeof fetch = async () => {
      throw new Error('fetch must not be called for blocked URLs');
    };
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
      fetchFn: fetchSpy,
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Metadata grab',
      payload: { kind: 'link', url: 'http://169.254.169.254/computeMetadata/v1/' },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('failed');
  });

  it('fetches link sources through the injected fetch', async () => {
    const article = `<html><body><article><h1>Ceviche</h1>
      <p>${'Ceviche is a coastal Peruvian dish cured in lime juice. '.repeat(8)}</p>
      <p>${'Lima restaurants serve it fresh through the afternoon. '.repeat(8)}</p>
      </article></body></html>`;
    const llm = new ScriptedLlmGateway([
      '{"sections":[{"topic":"Ceviche","start":1,"end":2}]}',
      ENRICH_CUISINE,
    ]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
      fetchFn: async () =>
        new Response(article, { status: 200, headers: { 'content-type': 'text/html' } }),
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Ceviche article',
      payload: { kind: 'link', url: 'https://example.com/ceviche' },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
    expect(await semantic.getSourceText(companionId, sourceId)).toContain('coastal Peruvian dish');
  });

  it('fails the job when a link returns a non-HTML content type', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
      fetchFn: async () =>
        new Response('%PDF-1.7 ...', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Binary link',
      payload: { kind: 'link', url: 'https://example.com/file.bin' },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('failed');
  });

  it('fails the job when a link body exceeds the byte ceiling', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();
    const oversized = `<html><body><article><p>${'x'.repeat(8192)}</p></article></body></html>`;

    await new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
      maxLinkBytes: 1024,
      fetchFn: async () =>
        new Response(oversized, { status: 200, headers: { 'content-type': 'text/html' } }),
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Huge page',
      payload: { kind: 'link', url: 'https://example.com/huge' },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/could not finish reading/);
  });

  async function embedText(text: string): Promise<readonly number[]> {
    const [vector] = await embeddings.embed({
      input: [text],
      model: 'fake-embed',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return vector!;
  }
});

/**
 * End-to-end ingestion pipeline tests against the real PGlite-backed store:
 * note → parse → segment → enrich → embed → done, with verbatim sections,
 * provenance-linked facts, retrievability, and the failure path.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingGateway, EmbeddingParams, EmbeddingResult } from '../embedding/gateway.js';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { LlmGateway, LlmStreamParams, StreamResult } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import type { TokenQuotaStore, UsageSnapshot } from '../quota/store.js';
import { estimateUsage } from '../usage.js';
import type { IngestionAnnouncer, IngestionOutcome } from './announcer.js';
import { createHttpLinkResolver } from './link-resolver.js';
import { IngestionPipeline } from './pipeline.js';
import { createSourceParser } from './source-parser.js';

/** Wrap a fake fetch as the pipeline's `sourceParser` (link path) for tests. */
function linkSourceParser(fetchFn: typeof fetch, maxBytes?: number) {
  return createSourceParser({
    linkResolver: createHttpLinkResolver(
      maxBytes === undefined ? { fetchFn } : { fetchFn, maxBytes },
    ),
  });
}

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

/** LLM fake returning one scripted response per call, in order (we own the seam). */
class ScriptedLlmGateway implements LlmGateway {
  readonly calls: LlmStreamParams[] = [];
  private next = 0;

  constructor(private readonly responses: readonly string[]) {}

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    this.calls.push(params);
    const response = this.responses[Math.min(this.next++, this.responses.length - 1)]!;
    yield response;
    return {
      usage: estimateUsage(params.messages.map((message) => message.content).join('\n'), response),
      toolCalls: [],
    };
  }
}

/** Embedding gateway that always throws (we own the seam) — for the embed-stage failure path. */
class ThrowingEmbeddingGateway implements EmbeddingGateway {
  async embed(_params: EmbeddingParams): Promise<EmbeddingResult> {
    throw new Error('embedding provider unavailable');
  }
}

/** Quota fake with a flippable over-cap flag (we own the seam). */
class StubQuota implements TokenQuotaStore {
  over = false;
  recorded = 0;

  async getUsage(): Promise<UsageSnapshot> {
    return { usedTokens: this.recorded, capTokens: 1000, resetsAt: '2026-06-04T00:00:00.000Z' };
  }
  async recordUsage(_userId: string, total: number): Promise<void> {
    this.recorded += total;
  }
  async isOverCap(): Promise<boolean> {
    return this.over;
  }
  async topUp(): Promise<void> {}
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

  function makePipeline(
    llm: LlmGateway,
    useContextHeader = false,
    quota?: TokenQuotaStore,
    announcer?: IngestionAnnouncer,
  ): IngestionPipeline {
    return new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader,
      logger: silentLogger,
      ...(quota ? { quota } : {}),
      ...(announcer ? { announcer } : {}),
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

  it('fails the job (user-safe) when embedding throws after enrichment, leaving sections as residue', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await new IngestionPipeline({
      semantic,
      llm,
      embeddings: new ThrowingEmbeddingGateway(),
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('failed');
    // User-safe message only — no provider/internal detail leaks.
    expect(job?.error).toMatch(/could not finish reading/);
    expect(job?.error).not.toMatch(/embedding provider|stack|Error/i);

    // Residue contract: segmentation + enrichment already committed, so the
    // verbatim sections (with context headers) persist; the embed stage never
    // completed, so NO section carries a vector — a pure-vector query (no
    // lexical overlap) returns nothing because there is nothing to match.
    expect(await semantic.getSourceText(companionId, sourceId)).toBe(NOTE_TEXT);
    const sections = await semantic.listSectionsBySource(companionId, sourceId);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.contextHeader).toContain('Pizarro founds Lima');

    const vectorHits = await semantic.search(companionId, {
      queryEmbedding: await embedText(sections[0]!.originalText),
      queryText: 'zzz-no-lexical-overlap',
      topK: 5,
    });
    expect(vectorHits).toHaveLength(0);
  });

  it('defers the AI passes (holding the parse) when the owner is over the daily cap', async () => {
    const quota = new StubQuota();
    quota.over = true;
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, quota).run({
      companionId,
      ownerId: 'owner',
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('deferred');
    // Parsing is free, so the canonical text is stored — but no AI passes ran.
    expect(await semantic.getSourceText(companionId, sourceId)).toBe(NOTE_TEXT);
    expect(await semantic.listSectionsBySource(companionId, sourceId)).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);

    const deferred = await semantic.listDeferredJobs();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.parsedDoc.paragraphs.length).toBeGreaterThan(0);
  });

  it('bills the per-run meter override (energy), not the default quota (Phase 4.1)', async () => {
    const defaultQuota = new StubQuota();
    const energyQuota = new StubQuota();
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, defaultQuota).run({
      companionId,
      ownerId: 'owner',
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
      // Autonomous read: bill ENERGY (the meter override), keyed by the companion.
      meter: { quota: energyQuota, accountId: companionId },
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
    expect(energyQuota.recorded).toBeGreaterThan(0); // energy was charged
    expect(defaultQuota.recorded).toBe(0); // the owner's stamina was not
  });

  it('does not defer an autonomous run (deferOnOverCap false) even when the meter is over cap', async () => {
    const energyQuota = new StubQuota();
    energyQuota.over = true; // "low on energy" — but the engine already gated
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
      meter: { quota: energyQuota, accountId: companionId },
      deferOnOverCap: false,
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done'); // proceeded; rollover debt absorbs overshoot
    expect(await semantic.listSectionsBySource(companionId, sourceId)).toHaveLength(2);
  });

  it('suppresses the per-source note when announce is false (Phase 4.1 burst)', async () => {
    const announced: IngestionOutcome[] = [];
    const announcer: IngestionAnnouncer = {
      async announce(outcome): Promise<void> {
        announced.push(outcome);
      },
    };
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, undefined, announcer).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
      announce: false,
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
    expect(announced).toHaveLength(0); // the engine posts one consolidated note instead
  });

  it('resumes a deferred job from its held parse once back under cap', async () => {
    const quota = new StubQuota();
    quota.over = true;
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();
    const pipeline = makePipeline(llm, false, quota);

    await pipeline.run({
      companionId,
      ownerId: 'owner',
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    const [deferred] = await semantic.listDeferredJobs();
    expect(deferred).toBeDefined();

    // Back under cap: resume from the held parse (no payload, no re-parse).
    quota.over = false;
    await pipeline.run({
      companionId,
      ownerId: 'owner',
      sourceId: deferred!.sourceId,
      jobId: deferred!.jobId,
      sourceTitle: deferred!.sourceTitle,
      resumeDocument: deferred!.parsedDoc,
    });

    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
    expect(await semantic.listSectionsBySource(companionId, sourceId)).toHaveLength(2);
    // The held parse is cleared once the job leaves the deferred state.
    expect(await semantic.listDeferredJobs()).toHaveLength(0);
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
      sourceParser: linkSourceParser(fetchSpy),
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
      sourceParser: linkSourceParser(
        async () =>
          new Response(article, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
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

  it('fails the job when a link returns unidentifiable binary content', async () => {
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    // No recognized content-type, no magic-byte match, no parseable extension,
    // and a NUL byte rules out the plain-text fallback → the resolver rejects.
    await new IngestionPipeline({
      semantic,
      llm,
      embeddings,
      ingestionModel: 'cheap-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      useContextHeader: false,
      logger: silentLogger,
      sourceParser: linkSourceParser(
        async () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      ),
    }).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Binary link',
      payload: { kind: 'link', url: 'https://example.com/photo.png' },
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
      sourceParser: linkSourceParser(
        async () =>
          new Response(oversized, { status: 200, headers: { 'content-type': 'text/html' } }),
        1024,
      ),
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

  it('announces done — before flipping the job — on a successful run', async () => {
    const seen: { outcome: string; jobStatusThen: string | undefined }[] = [];
    const announcer: IngestionAnnouncer = {
      async announce(o: IngestionOutcome): Promise<void> {
        const [job] = await semantic.listJobs(companionId);
        seen.push({ outcome: o.outcome, jobStatusThen: job?.status });
      },
    };
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, undefined, announcer).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    expect(seen).toEqual([{ outcome: 'done', jobStatusThen: 'embedding' }]);
    const [job] = await semantic.listJobs(companionId);
    expect(job?.status).toBe('done');
  });

  it('announces failed when a run fails', async () => {
    const outcomes: string[] = [];
    const announcer: IngestionAnnouncer = {
      async announce(o: IngestionOutcome): Promise<void> {
        outcomes.push(o.outcome);
      },
    };
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, undefined, announcer).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Broken PDF',
      payload: { kind: 'pdf', bytes: new TextEncoder().encode('not a pdf') },
    });

    expect(outcomes).toEqual(['failed']);
    expect((await semantic.listJobs(companionId))[0]?.status).toBe('failed');
  });

  it('does not announce a deferred (non-terminal) run', async () => {
    const outcomes: string[] = [];
    const announcer: IngestionAnnouncer = {
      async announce(o: IngestionOutcome): Promise<void> {
        outcomes.push(o.outcome);
      },
    };
    const quota = new StubQuota();
    quota.over = true;
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, quota, announcer).run({
      companionId,
      ownerId: 'owner',
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    expect((await semantic.listJobs(companionId))[0]?.status).toBe('deferred');
    expect(outcomes).toEqual([]);
  });

  it('still records the outcome when the announcer throws', async () => {
    const throwingAnnouncer: IngestionAnnouncer = {
      async announce(): Promise<void> {
        throw new Error('announcer boom');
      },
    };
    const llm = new ScriptedLlmGateway([SEGMENT_RESPONSE, ENRICH_CONQUEST, ENRICH_CUISINE]);
    const { sourceId, jobId } = await seedSourceAndJob();

    await makePipeline(llm, false, undefined, throwingAnnouncer).run({
      companionId,
      sourceId,
      jobId,
      sourceTitle: 'Peru notes',
      payload: { kind: 'note', text: NOTE_TEXT },
    });

    // A notification failure must never change the recorded job outcome.
    expect((await semantic.listJobs(companionId))[0]?.status).toBe('done');
  });

  async function embedText(text: string): Promise<readonly number[]> {
    const {
      vectors: [vector],
    } = await embeddings.embed({
      input: [text],
      model: 'fake-embed',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return vector!;
  }
});

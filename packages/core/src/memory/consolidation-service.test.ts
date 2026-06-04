/**
 * Integration tests for the consolidation service + sweep against the real
 * in-memory database: it reflects a transcript window into embedded episodes,
 * advances the cursor (even on filler), gates on minTurns and the daily cap,
 * degrades when embeddings fail, and the sweep wakes only companions with a
 * long-enough pending tail. The LLM + embeddings are faked.
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import type { EmbeddingGateway } from '../embedding/gateway.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { TokenQuotaStore, UsageSnapshot } from '../quota/store.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import {
  ConsolidationService,
  sweepConsolidation,
  type ConsolidationServiceOptions,
} from './consolidation-service.js';
import { DrizzleEpisodicMemoryStore } from './episodic-store.js';
import { TranscriptMemoryStore } from './store.js';

const EMBEDDING_DIMENSIONS = 1024;
const logger = { error: vi.fn(), info: vi.fn() };

/** A fake quota with a fixed over-cap verdict and a recordUsage spy. */
class FakeQuota implements TokenQuotaStore {
  recorded = 0;
  constructor(private readonly overCap = false) {}
  async getUsage(): Promise<UsageSnapshot> {
    return { usedTokens: 0, capTokens: 1_000_000, resetsAt: '2026-01-01T00:00:00.000Z' };
  }
  async recordUsage(_userId: string, totalTokens: number): Promise<void> {
    this.recorded += totalTokens;
  }
  async isOverCap(): Promise<boolean> {
    return this.overCap;
  }
}

const EPISODE_JSON =
  '{"episodes":[{"summary":"You loved the ceviche in Lima — lime, never lemon.","startSeq":1,"endSeq":4,"salience":0.9}]}';

describe('ConsolidationService', () => {
  let close: () => Promise<void>;
  let episodic: DrizzleEpisodicMemoryStore;
  let memory: TranscriptMemoryStore;
  let identity: DrizzleIdentityStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    episodic = new DrizzleEpisodicMemoryStore(created.db);
    memory = new TranscriptMemoryStore(created.db);
    identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'a fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  async function seedTurns(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await memory.appendMessage(companionId, role, `turn ${i + 1}`);
    }
  }

  function service(
    overrides: Partial<ConsolidationServiceOptions> = {},
    llm = new FakeLlmGateway([EPISODE_JSON]),
    embeddings: EmbeddingGateway = new FakeEmbeddingGateway(),
  ): ConsolidationService {
    return new ConsolidationService({
      episodic,
      memory,
      identity,
      llm,
      embeddings,
      consolidationModel: 'fake-model',
      embeddingModel: 'fake-embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      logger,
      ...overrides,
    });
  }

  it('reflects a window into an embedded episode and advances the cursor', async () => {
    await seedTurns(8);
    const quota = new FakeQuota(false);

    await service({ quota }).consolidate(companionId);

    expect(await episodic.countEpisodes(companionId)).toBe(1);
    expect(await episodic.consolidatedThroughSeq(companionId)).toBe(8);
    expect(quota.recorded).toBeGreaterThan(0);

    // The episode was embedded → recoverable via the vector arm.
    const gateway = new FakeEmbeddingGateway();
    const {
      vectors: [queryVector],
    } = await gateway.embed({
      input: ['ceviche in Lima'],
      model: 'fake-embed',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const hits = await episodic.searchEpisodes(companionId, {
      queryEmbedding: queryVector!,
      queryText: 'ceviche',
      topK: 5,
    });
    expect(hits[0]?.summary).toContain('ceviche');
  });

  it('does nothing until minTurns of new transcript have accrued', async () => {
    await seedTurns(3); // below the default minTurns (6)
    await service().consolidate(companionId);
    expect(await episodic.countEpisodes(companionId)).toBe(0);
    expect(await episodic.consolidatedThroughSeq(companionId)).toBe(0);
  });

  it('advances the cursor past a span of pure filler (zero episodes)', async () => {
    await seedTurns(8);
    await service({}, new FakeLlmGateway(['{"episodes":[]}'])).consolidate(companionId);
    expect(await episodic.countEpisodes(companionId)).toBe(0);
    expect(await episodic.consolidatedThroughSeq(companionId)).toBe(8);
  });

  it('skips (no cursor advance) when the owner is over the daily cap', async () => {
    await seedTurns(8);
    await service({ quota: new FakeQuota(true) }).consolidate(companionId);
    expect(await episodic.countEpisodes(companionId)).toBe(0);
    expect(await episodic.consolidatedThroughSeq(companionId)).toBe(0);
  });

  it('stores episodes lexical-only when embedding fails (never loses them)', async () => {
    await seedTurns(8);
    const failingEmbeddings: EmbeddingGateway = {
      embed: vi.fn().mockRejectedValue(new Error('embeddings down')),
    };
    await service({}, new FakeLlmGateway([EPISODE_JSON]), failingEmbeddings).consolidate(
      companionId,
    );

    expect(await episodic.countEpisodes(companionId)).toBe(1);
    expect(await episodic.consolidatedThroughSeq(companionId)).toBe(8);
    // Still recalled lexically (FTS over the summary), embedding absent.
    const hits = await episodic.searchEpisodes(companionId, {
      queryEmbedding: [],
      queryText: 'ceviche',
      topK: 5,
    });
    expect(hits).toHaveLength(1);
  });

  it('does nothing for a companion deleted between trigger and run', async () => {
    await seedTurns(8);
    await expect(
      service().consolidate('00000000-0000-0000-0000-000000000000'),
    ).resolves.not.toThrow();
  });

  it('triggers personality evolution only when episodes were formed', async () => {
    const evolver = { evolve: vi.fn().mockResolvedValue(undefined) };

    // A span that yields an episode (seqs 1–8, cited 1–4) → evolution fired.
    await seedTurns(8);
    await service({ evolver }, new FakeLlmGateway([EPISODE_JSON])).consolidate(companionId);
    expect(evolver.evolve).toHaveBeenCalledWith(companionId);
    expect(evolver.evolve).toHaveBeenCalledTimes(1);

    // A fresh companion whose span is pure filler → evolution NOT fired.
    const user = await identity.ensureUserByEmail('owner@example.com');
    const quiet = await identity.createCompanion(user.id, {
      name: 'Quiet',
      form: 'owl',
      temperament: 'calm',
    });
    for (let i = 0; i < 8; i++) await memory.appendMessage(quiet.id, 'user', `m${i}`);
    await service({ evolver }, new FakeLlmGateway(['{"episodes":[]}'])).consolidate(quiet.id);
    expect(evolver.evolve).toHaveBeenCalledTimes(1); // still only the first
  });
});

describe('sweepConsolidation', () => {
  let close: () => Promise<void>;
  let episodic: DrizzleEpisodicMemoryStore;
  let memory: TranscriptMemoryStore;
  let identity: DrizzleIdentityStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    episodic = new DrizzleEpisodicMemoryStore(created.db);
    memory = new TranscriptMemoryStore(created.db);
    identity = new DrizzleIdentityStore(created.db);
  });

  afterEach(async () => {
    await close();
  });

  it('requests only companions whose pending tail meets the threshold', async () => {
    const user = await identity.ensureUserByEmail('owner@example.com');
    const busy = await identity.createCompanion(user.id, {
      name: 'Busy',
      form: 'fox',
      temperament: 'x',
    });
    const quiet = await identity.createCompanion(user.id, {
      name: 'Quiet',
      form: 'owl',
      temperament: 'y',
    });
    for (let i = 0; i < 8; i++) await memory.appendMessage(busy.id, 'user', `m${i}`);
    for (let i = 0; i < 2; i++) await memory.appendMessage(quiet.id, 'user', `m${i}`);

    const requested: string[] = [];
    const count = await sweepConsolidation({
      episodic,
      runner: { request: (id) => requested.push(id) },
      logger,
      minTurns: 6,
    });

    expect(count).toBe(1);
    expect(requested).toEqual([busy.id]);
    expect(requested).not.toContain(quiet.id);
  });
});

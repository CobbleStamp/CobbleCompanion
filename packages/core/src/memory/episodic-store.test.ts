/**
 * Tests for the episodic memory store: append + cursor advance, hybrid
 * (vector + lexical) recall with a wall-clock time window, the episode timeline,
 * counts, and owner scoping — against the real in-memory PGlite database with
 * pgvector loaded.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEpisodicMemoryStore, type NewEpisode } from './episodic-store.js';

const gateway = new FakeEmbeddingGateway();

async function embedOne(text: string): Promise<readonly number[]> {
  const {
    vectors: [vector],
  } = await gateway.embed({ input: [text], model: 'fake', dimensions: EMBEDDING_DIMENSIONS });
  return vector!;
}

describe('DrizzleEpisodicMemoryStore', () => {
  let store: DrizzleEpisodicMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;
  let otherCompanionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleEpisodicMemoryStore(created.db);
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

  /** Append one embedded episode (cursor → its seqEnd); returns its id. */
  async function seed(
    summary: string,
    opts: {
      seqStart: number;
      seqEnd: number;
      occurredStart: Date;
      occurredEnd: Date;
      salience?: number;
      companion?: string;
      embed?: boolean;
    },
  ): Promise<string> {
    const owner = opts.companion ?? companionId;
    const episode: NewEpisode = {
      summary,
      seqStart: opts.seqStart,
      seqEnd: opts.seqEnd,
      occurredStart: opts.occurredStart,
      occurredEnd: opts.occurredEnd,
      ...(opts.salience !== undefined ? { salience: opts.salience } : {}),
      ...(opts.embed === false ? {} : { embedding: await embedOne(summary) }),
    };
    const [record] = await store.appendEpisodes(owner, [episode], opts.seqEnd);
    return record!.id;
  }

  const jan = {
    occurredStart: new Date('2026-01-10T00:00:00Z'),
    occurredEnd: new Date('2026-01-10T01:00:00Z'),
  };
  const mar = {
    occurredStart: new Date('2026-03-10T00:00:00Z'),
    occurredEnd: new Date('2026-03-10T01:00:00Z'),
  };

  it('appends episodes and advances the consolidation cursor atomically', async () => {
    expect(await store.consolidatedThroughSeq(companionId)).toBe(0);
    await seed('You loved the ceviche in Lima', { seqStart: 1, seqEnd: 8, ...jan, salience: 0.9 });
    expect(await store.countEpisodes(companionId)).toBe(1);
    expect(await store.consolidatedThroughSeq(companionId)).toBe(8);
  });

  it('advances the cursor on an empty batch (a span of pure filler)', async () => {
    await store.appendEpisodes(companionId, [], 20);
    expect(await store.countEpisodes(companionId)).toBe(0);
    expect(await store.consolidatedThroughSeq(companionId)).toBe(20);
  });

  it('recalls the semantically closest episode first (vector arm)', async () => {
    const lima = await seed('You loved the ceviche in Lima', { seqStart: 1, seqEnd: 8, ...jan });
    await seed('We debugged your printer for an hour', { seqStart: 9, seqEnd: 20, ...mar });

    const hits = await store.searchEpisodes(companionId, {
      queryEmbedding: await embedOne('You loved the ceviche in Lima'),
      queryText: 'You loved the ceviche in Lima',
      topK: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.episodeId).toBe(lima);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('recalls by keyword when the embedding provider is down (lexical-only)', async () => {
    const ceviche = await seed('You loved the ceviche in Lima', {
      seqStart: 1,
      seqEnd: 8,
      ...jan,
      embed: false,
    });
    await seed('We debugged your printer for an hour', {
      seqStart: 9,
      seqEnd: 20,
      ...mar,
      embed: false,
    });

    const hits = await store.searchEpisodes(companionId, {
      queryEmbedding: [],
      queryText: 'ceviche',
      topK: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.episodeId).toBe(ceviche);
  });

  it('restricts recall to a wall-clock window (recall-by-time)', async () => {
    const january = await seed('Our trip planning chat', { seqStart: 1, seqEnd: 8, ...jan });
    await seed('Our trip recap chat', { seqStart: 9, seqEnd: 20, ...mar });

    const hits = await store.searchEpisodes(companionId, {
      queryEmbedding: [],
      queryText: 'trip',
      topK: 5,
      filters: {
        after: new Date('2026-01-01T00:00:00Z'),
        before: new Date('2026-02-01T00:00:00Z'),
      },
    });

    expect(hits.map((h) => h.episodeId)).toEqual([january]);
  });

  it('lists the timeline most-recent-first and honors a limit', async () => {
    await seed('January chat', { seqStart: 1, seqEnd: 8, ...jan });
    await seed('March chat', { seqStart: 9, seqEnd: 20, ...mar });

    const all = await store.listEpisodes(companionId);
    expect(all.map((e) => e.summary)).toEqual(['March chat', 'January chat']);

    const latest = await store.listEpisodes(companionId, { limit: 1 });
    expect(latest.map((e) => e.summary)).toEqual(['March chat']);
  });

  it('scopes every read to its companion', async () => {
    await seed('A Pebble memory', { seqStart: 1, seqEnd: 8, ...jan });
    await seed('A Cobble memory', {
      seqStart: 1,
      seqEnd: 8,
      ...mar,
      companion: otherCompanionId,
    });

    expect(await store.countEpisodes(companionId)).toBe(1);
    expect(await store.countEpisodes(otherCompanionId)).toBe(1);
    const hits = await store.searchEpisodes(companionId, {
      queryEmbedding: [],
      queryText: 'memory',
      topK: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.summary).toBe('A Pebble memory');
    // The other companion's cursor is independent.
    expect(await store.consolidatedThroughSeq(otherCompanionId)).toBe(8);
  });
});

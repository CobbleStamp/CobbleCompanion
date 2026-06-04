/**
 * Integration tests for personality evolution against the real in-memory DB:
 * it re-synthesizes the evolved persona from recent episodes, advances the
 * evolution cursor, self-gates when nothing is new, gates on the daily cap, and
 * never throws. The LLM is faked.
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { DrizzleEpisodicMemoryStore, type NewEpisode } from '../memory/episodic-store.js';
import type { TokenQuotaStore, UsageSnapshot } from '../quota/store.js';
import { LlmPersonalityEvolver, type PersonalityEvolverOptions } from './evolve.js';

const logger = { error: vi.fn(), info: vi.fn() };
const PERSONA_TEXT = "You've grown playful with them, and you know they unwind by cooking.";

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

describe('LlmPersonalityEvolver', () => {
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let episodic: DrizzleEpisodicMemoryStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    identity = new DrizzleIdentityStore(created.db);
    episodic = new DrizzleEpisodicMemoryStore(created.db);
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

  async function seedEpisodes(throughSeq: number): Promise<void> {
    const episode: NewEpisode = {
      summary: 'You loved the ceviche in Lima',
      seqStart: 1,
      seqEnd: throughSeq,
      occurredStart: new Date('2026-01-10T00:00:00Z'),
      occurredEnd: new Date('2026-01-10T01:00:00Z'),
      salience: 0.9,
    };
    await episodic.appendEpisodes(companionId, [episode], throughSeq);
  }

  function evolver(
    overrides: Partial<PersonalityEvolverOptions> = {},
    llm = new FakeLlmGateway([PERSONA_TEXT]),
  ): LlmPersonalityEvolver {
    return new LlmPersonalityEvolver({
      identity,
      episodic,
      llm,
      model: 'fake-model',
      logger,
      ...overrides,
    });
  }

  it('synthesizes and persists the evolved persona, advancing the cursor', async () => {
    await seedEpisodes(8);
    const quota = new FakeQuota(false);

    await evolver({ quota }).evolve(companionId);

    const record = await identity.getCompanionById(companionId);
    expect(record?.evolvedPersona).toBe(PERSONA_TEXT);
    expect(record?.personaUpdatedThroughSeq).toBe(8);
    expect(quota.recorded).toBeGreaterThan(0);
    // The blended persona now carries the growth.
    const dto = await identity.getCompanion(companionId, record!.ownerId);
    expect(dto?.evolvedPersona).toBe(PERSONA_TEXT);
  });

  it('is a no-op when nothing new has consolidated since the last evolution', async () => {
    await seedEpisodes(8);
    const llm = new FakeLlmGateway([PERSONA_TEXT]);
    const spy = vi.spyOn(llm, 'stream');
    await evolver({}, llm).evolve(companionId); // first run synthesizes
    await evolver({}, llm).evolve(companionId); // second: cursor caught up → skip
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips synthesis when the owner is over the daily cap', async () => {
    await seedEpisodes(8);
    const llm = new FakeLlmGateway([PERSONA_TEXT]);
    const spy = vi.spyOn(llm, 'stream');
    await evolver({ quota: new FakeQuota(true) }, llm).evolve(companionId);
    expect(spy).not.toHaveBeenCalled();
    const record = await identity.getCompanionById(companionId);
    expect(record?.evolvedPersona).toBeNull();
  });

  it('does not throw for a companion deleted between trigger and run', async () => {
    await expect(evolver().evolve('00000000-0000-0000-0000-000000000000')).resolves.not.toThrow();
  });
});

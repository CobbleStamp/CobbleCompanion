/**
 * Tier-3 user-persona synthesizer (Phase 13) — the mirror of the Personality Evolver,
 * pointed at the user. Re-synthesizes `companions.user_persona` from the user's current
 * facts + recent episodes on its own cursor, gated/metered, never throwing.
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { DrizzleEpisodicMemoryStore, type NewEpisode } from '../memory/episodic-store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { DrizzleUserModelStore } from './store.js';
import { LlmUserPersonaSynthesizer, type UserPersonaSynthesizerOptions } from './synthesize.js';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const PERSONA_TEXT = 'They come to you to think out loud and value candour over comfort.';

class FakeQuota implements VitalityStore {
  recorded = 0;
  constructor(private readonly overCap = false) {}
  async getBalance(): Promise<number> {
    return this.overCap ? 0 : 1_000_000;
  }
  async spend(_companionId: string, totalTokens: number): Promise<void> {
    this.recorded += totalTokens;
  }
  async add(): Promise<void> {}
  async isEmpty(): Promise<boolean> {
    return this.overCap;
  }
}

describe('LlmUserPersonaSynthesizer', () => {
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let episodic: DrizzleEpisodicMemoryStore;
  let userModel: DrizzleUserModelStore;
  let companionId: string;
  let userId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    identity = new DrizzleIdentityStore(created.db);
    episodic = new DrizzleEpisodicMemoryStore(created.db);
    userModel = new DrizzleUserModelStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(userId, {
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
      summary: 'You helped them plan a trip to Lisbon.',
      seqStart: 1,
      seqEnd: throughSeq,
      occurredStart: new Date('2026-01-10T00:00:00Z'),
      occurredEnd: new Date('2026-01-10T01:00:00Z'),
      salience: 0.9,
    };
    await episodic.appendEpisodes(companionId, [episode], throughSeq);
  }

  function synthesizer(
    overrides: Partial<UserPersonaSynthesizerOptions> = {},
    llm = new FakeLlmGateway([PERSONA_TEXT]),
  ): LlmUserPersonaSynthesizer {
    return new LlmUserPersonaSynthesizer({
      identity,
      episodic,
      store: userModel,
      llm,
      model: 'fake-model',
      logger,
      ...overrides,
    });
  }

  it('synthesizes and persists the user persona, advancing its own cursor', async () => {
    await userModel.recordBelief({ userId, predicate: 'interestedIn', object: 'jazz' });
    await seedEpisodes(8); // advances consolidatedThroughSeq past the persona cursor (0)
    const quota = new FakeQuota(false);

    await synthesizer({ quota }).synthesize(companionId);

    const record = await identity.getCompanionById(companionId);
    expect(record?.userPersona).toBe(PERSONA_TEXT);
    expect(record?.userModelUpdatedThroughSeq).toBe(8);
    expect(quota.recorded).toBeGreaterThan(0);
    // The blended persona DTO now carries the Tier-3 understanding.
    const dto = await identity.getCompanion(companionId, userId);
    expect(dto?.userPersona).toBe(PERSONA_TEXT);
  });

  it('re-synthesizes when the belief cursor advances (not only episodes)', async () => {
    await userModel.recordBelief({ userId, predicate: 'interestedIn', object: 'jazz' });
    await identity.advanceUserFactsThroughSeq(companionId, 4); // beliefs advanced, no episodes
    await synthesizer().synthesize(companionId);
    const record = await identity.getCompanionById(companionId);
    expect(record?.userPersona).toBe(PERSONA_TEXT);
    expect(record?.userModelUpdatedThroughSeq).toBe(4);
  });

  it('is a no-op when neither cursor has advanced since the last synthesis', async () => {
    await seedEpisodes(8);
    const llm = new FakeLlmGateway([PERSONA_TEXT, PERSONA_TEXT]);
    const spy = vi.spyOn(llm, 'stream');
    await synthesizer({}, llm).synthesize(companionId); // first synthesizes
    await synthesizer({}, llm).synthesize(companionId); // cursor caught up → skip
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips synthesis when the stamina wallet is empty', async () => {
    await userModel.recordBelief({ userId, predicate: 'interestedIn', object: 'jazz' });
    await seedEpisodes(8);
    const llm = new FakeLlmGateway([PERSONA_TEXT]);
    const spy = vi.spyOn(llm, 'stream');
    await synthesizer({ quota: new FakeQuota(true) }, llm).synthesize(companionId);
    expect(spy).not.toHaveBeenCalled();
    const record = await identity.getCompanionById(companionId);
    expect(record?.userPersona).toBeNull();
  });

  it('does not throw for a companion deleted between trigger and run', async () => {
    await expect(
      synthesizer().synthesize('00000000-0000-0000-0000-000000000000'),
    ).resolves.not.toThrow();
  });
});

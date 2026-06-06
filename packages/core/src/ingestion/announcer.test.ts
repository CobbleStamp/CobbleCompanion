import { ingestionDoneFallback, ingestionFailedFallback } from '@cobble/shared';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import { LlmIngestionAnnouncer } from './announcer.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

/** Controllable quota fake — toggles over-cap and records what was debited. */
class FakeQuota implements TokenQuotaStore {
  overCap = false;
  readonly recorded: number[] = [];
  async getUsage(): Promise<never> {
    throw new Error('unused in announcer tests');
  }
  async recordUsage(_userId: string, totalTokens: number): Promise<void> {
    this.recorded.push(totalTokens);
  }
  async isOverCap(): Promise<boolean> {
    return this.overCap;
  }
  async topUp(): Promise<void> {}
}

/** A gateway whose stream throws, to drive the generation-failure fallback. */
const throwingLlm: LlmGateway = {
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('llm unavailable');
  },
};

describe('LlmIngestionAnnouncer', () => {
  let memory: TranscriptMemoryStore;
  let identity: DrizzleIdentityStore;
  let quota: FakeQuota;
  let close: () => Promise<void>;
  let companionId: string;
  let ownerId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    memory = new TranscriptMemoryStore(created.db);
    identity = new DrizzleIdentityStore(created.db);
    quota = new FakeQuota();
    const user = await identity.ensureUserByEmail('owner@example.com');
    ownerId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'a curious fox',
      temperament: 'warm and a little wry',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  async function lastTurn(): Promise<{ role: string; content: string } | undefined> {
    const [turn] = await memory.getRecentMessages(companionId, 1);
    return turn ? { role: turn.role, content: turn.content } : undefined;
  }

  it('posts an in-character note and debits its tokens on success', async () => {
    const llm = new FakeLlmGateway(['All done with that ', 'one — ask away.']);
    const announcer = new LlmIngestionAnnouncer({
      identity,
      memory,
      llm,
      model: 'cheap-model',
      quota,
      logger: silentLogger,
    });

    await announcer.announce({ companionId, ownerId, sourceTitle: 'Peru book', outcome: 'done' });

    const turn = await lastTurn();
    expect(turn?.role).toBe('assistant');
    expect(turn?.content).toBe('All done with that one — ask away.');
    // The persona drives the system prompt; the title reaches the instruction.
    expect(llm.lastParams?.messages[0]?.content).toContain('Pebble');
    expect(llm.lastParams?.messages[1]?.content).toContain('Peru book');
    // The call is stamped with its prompt version (prompts/registry) for tracing.
    expect(llm.lastParams?.promptRef?.id).toBe('ingestion-announce');
    expect(llm.lastParams?.promptRef?.version.contentHash).toMatch(/^[0-9a-f]{16}$/);
    // Generation spent tokens, so the owner was debited (positive amount).
    expect(quota.recorded.length).toBe(1);
    expect(quota.recorded[0]!).toBeGreaterThan(0);
  });

  it('asks for an apologetic note on failure', async () => {
    const llm = new FakeLlmGateway(['Sorry, I could not finish.']);
    const announcer = new LlmIngestionAnnouncer({
      identity,
      memory,
      llm,
      model: 'cheap-model',
      quota,
      logger: silentLogger,
    });

    await announcer.announce({
      companionId,
      ownerId,
      sourceTitle: 'broken.pdf',
      outcome: 'failed',
    });

    const turn = await lastTurn();
    expect(turn?.content).toBe('Sorry, I could not finish.');
    expect(llm.lastParams?.messages[1]?.content).toMatch(/couldn't finish|try uploading it again/);
  });

  it('falls back to the canned line when the owner is over cap (no tokens spent)', async () => {
    quota.overCap = true;
    const llm = new FakeLlmGateway(['should not be used']);
    const announcer = new LlmIngestionAnnouncer({
      identity,
      memory,
      llm,
      model: 'cheap-model',
      quota,
      logger: silentLogger,
    });

    await announcer.announce({ companionId, ownerId, sourceTitle: 'Peru book', outcome: 'done' });

    const turn = await lastTurn();
    expect(turn?.content).toBe(ingestionDoneFallback('Peru book'));
    // No generation, no debit.
    expect(llm.lastParams).toBeNull();
    expect(quota.recorded.length).toBe(0);
  });

  it('falls back to the canned line when generation throws', async () => {
    const announcer = new LlmIngestionAnnouncer({
      identity,
      memory,
      llm: throwingLlm,
      model: 'cheap-model',
      quota,
      logger: silentLogger,
    });

    await announcer.announce({
      companionId,
      ownerId,
      sourceTitle: 'broken.pdf',
      outcome: 'failed',
    });

    expect((await lastTurn())?.content).toBe(ingestionFailedFallback('broken.pdf'));
  });

  it('falls back to the canned line when no owner is given (no persona to voice it)', async () => {
    const llm = new FakeLlmGateway(['should not be used']);
    const announcer = new LlmIngestionAnnouncer({
      identity,
      memory,
      llm,
      model: 'cheap-model',
      quota,
      logger: silentLogger,
    });

    await announcer.announce({ companionId, sourceTitle: 'Peru book', outcome: 'done' });

    expect((await lastTurn())?.content).toBe(ingestionDoneFallback('Peru book'));
    expect(llm.lastParams).toBeNull();
  });
});

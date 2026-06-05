import type { CompanionDto } from '@cobble/shared';
import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { Harness } from './harness.js';
import { createSemanticRetrieveContext } from './semantic-retrieve.js';

const silentLogger: Logger = { error: () => {}, info: () => {} };

/** Records every debit so a test can assert what a turn billed (or didn't). */
class RecordingQuota implements TokenQuotaStore {
  readonly recorded: number[] = [];
  async getUsage(): Promise<{ usedTokens: number; capTokens: number; resetsAt: string }> {
    return { usedTokens: 0, capTokens: 1_000_000, resetsAt: '' };
  }
  async recordUsage(_userId: string, totalTokens: number): Promise<void> {
    this.recorded.push(totalTokens);
  }
  async isOverCap(): Promise<boolean> {
    return false;
  }
}

describe('Harness.runTurn (Phase 0 single-pass loop)', () => {
  let close: () => Promise<void>;
  let memory: TranscriptMemoryStore;
  let semantic: DrizzleSemanticMemoryStore;
  let companion: CompanionDto;
  const embeddings = new FakeEmbeddingGateway();

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    const identity = new DrizzleIdentityStore(created.db);
    memory = new TranscriptMemoryStore(created.db);
    semantic = new DrizzleSemanticMemoryStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
  });

  afterEach(async () => {
    await close();
  });

  it('streams tokens, persists both turns, and exits with done', async () => {
    const gateway = new FakeLlmGateway(['Hel', 'lo']);
    const harness = new Harness({
      gateway,
      memory,
      model: 'test-model',
      logger: silentLogger,
    });

    const events = [];
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi there',
    })) {
      events.push(event);
    }

    const tokens = events
      .filter((e) => e.type === 'token')
      .map((e) => (e.type === 'token' ? e.value : ''))
      .join('');
    expect(tokens).toBe('Hello');

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.message.role).toBe('assistant');
      expect(done.message.content).toBe('Hello');
    }

    const transcript = await memory.getRecentMessages(companion.id, 10);
    expect(transcript.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi there'],
      ['assistant', 'Hello'],
    ]);
  });

  it('assembles context with the persona system prompt and the user turn', async () => {
    const gateway = new FakeLlmGateway(['ok']);
    const harness = new Harness({
      gateway,
      memory,
      model: 'test-model',
      logger: silentLogger,
    });

    // drain
    for await (const _event of harness.runTurn({
      companion,
      userContent: 'remember this',
    })) {
      void _event;
    }

    const params = gateway.lastParams;
    expect(params?.messages[0]?.role).toBe('system');
    expect(params?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'remember this',
    });
  });

  it('surfaces a provider failure as a terminal error event', async () => {
    const failing: LlmGateway = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('provider exploded');
      },
    };
    const harness = new Harness({
      gateway: failing,
      memory,
      model: 'test-model',
      logger: silentLogger,
    });

    const events = [];
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi',
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('error');
    // The user turn was still recorded; no assistant turn was persisted.
    const transcript = await memory.getRecentMessages(companion.id, 10);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.role).toBe('user');
  });

  it('does not bill a turn that fails on the provider side (free for our faults)', async () => {
    const failing: LlmGateway = {
      async *stream() {
        yield 'partial answer'; // tokens consumed before the drop
        throw new Error('network drop');
      },
    };
    const quota = new RecordingQuota();
    const harness = new Harness({
      gateway: failing,
      memory,
      model: 'test-model',
      logger: silentLogger,
      quota,
    });

    const events = [];
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi',
      ownerId: 'owner-1',
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('error');
    // The failed turn is our fault — nothing is debited (billing-crash-compensation).
    expect(quota.recorded).toEqual([]);
  });

  it('bills the tokens already streamed when the client disconnects mid-stream', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['Hel', 'lo', ' world'] }]);
    const quota = new RecordingQuota();
    const harness = new Harness({
      gateway,
      memory,
      model: 'test-model',
      logger: silentLogger,
      quota,
    });

    // Consume the first token, then disconnect (break) before the stream's usage
    // frame — the classic stream-then-abort that must not yield free output.
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi there',
      ownerId: 'owner-1',
    })) {
      if (event.type === 'token') break;
    }

    // The consumed tokens were metered and debited, not silently dropped.
    expect(quota.recorded).toHaveLength(1);
    expect(quota.recorded[0]).toBeGreaterThan(0);
  });

  describe('with semantic recall (Phase 1 RetrieveContext)', () => {
    /** Seed one embedded section so retrieval has something to ground on. */
    async function seedSection(text: string): Promise<void> {
      const source = await semantic.createSource(companion.id, {
        kind: 'note',
        title: 'Peru: A Culinary History',
        rawText: text,
      });
      const [section] = await semantic.insertSections(companion.id, source.id, [
        { topicTitle: 'Ceviche origins', originalText: text, paraStart: 3, paraEnd: 5, ord: 0 },
      ]);
      const {
        vectors: [vector],
      } = await embeddings.embed({
        input: [text],
        model: 'fake-embed',
        dimensions: EMBEDDING_DIMENSIONS,
      });
      await semantic.setSectionEmbedding(section!.id, vector!);
    }

    function makeHarness(gateway: LlmGateway): Harness {
      return new Harness({
        gateway,
        memory,
        model: 'test-model',
        logger: silentLogger,
        retrieveContext: createSemanticRetrieveContext({
          memory,
          semantic,
          embeddings,
          embeddingModel: 'fake-embed',
          embeddingDimensions: EMBEDDING_DIMENSIONS,
          logger: silentLogger,
        }),
      });
    }

    it('grounds the turn in retrieved passages and yields citations before done', async () => {
      await seedSection('Ceviche is cured with lime juice along the Lima coast.');
      const gateway = new FakeLlmGateway(['Grounded answer']);

      const events = [];
      for await (const event of makeHarness(gateway).runTurn({
        companion,
        // Identical text → identical fake embedding → guaranteed vector hit.
        userContent: 'Ceviche is cured with lime juice along the Lima coast.',
      })) {
        events.push(event);
      }

      const citationEvents = events.filter((e) => e.type === 'citations');
      expect(citationEvents).toHaveLength(1);
      if (citationEvents[0]?.type === 'citations') {
        expect(citationEvents[0].citations[0]).toMatchObject({
          sourceTitle: 'Peru: A Culinary History',
          topicTitle: 'Ceviche origins',
          paraStart: 3,
          paraEnd: 5,
        });
      }
      // Citations precede the terminal done event.
      expect(events.findIndex((e) => e.type === 'citations')).toBeLessThan(
        events.findIndex((e) => e.type === 'done'),
      );

      // The retrieved verbatim passage entered the prompt with its source named.
      const sent = gateway.lastParams?.messages.map((m) => m.content).join('\n') ?? '';
      expect(sent).toContain('Peru: A Culinary History');
      expect(sent).toContain('Ceviche is cured with lime juice along the Lima coast.');
    });

    it('yields no citations when the companion has no relevant knowledge', async () => {
      const gateway = new FakeLlmGateway(['I do not know']);

      const events = [];
      for await (const event of makeHarness(gateway).runTurn({
        companion,
        userContent: 'What do my books say about Bolivian salt flats?',
      })) {
        events.push(event);
      }

      expect(events.some((e) => e.type === 'citations')).toBe(false);
      expect(events.at(-1)?.type).toBe('done');
    });

    it('degrades to recency-only context when the embedding provider fails', async () => {
      await seedSection('Ceviche is cured with lime juice.');
      const gateway = new FakeLlmGateway(['Still works']);
      const harness = new Harness({
        gateway,
        memory,
        model: 'test-model',
        logger: silentLogger,
        retrieveContext: createSemanticRetrieveContext({
          memory,
          semantic,
          embeddings: {
            embed: async () => {
              throw new Error('embedding provider down');
            },
          },
          embeddingModel: 'fake-embed',
          embeddingDimensions: EMBEDDING_DIMENSIONS,
          logger: silentLogger,
        }),
      });

      const events = [];
      for await (const event of harness.runTurn({ companion, userContent: 'hello' })) {
        events.push(event);
      }

      // The conversation survives: no citations, but a normal done exit.
      expect(events.some((e) => e.type === 'citations')).toBe(false);
      expect(events.at(-1)?.type).toBe('done');
    });
  });
});

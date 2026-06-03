import type { CompanionDto } from '@cobble/shared';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { Harness } from './harness.js';

const silentLogger: Logger = { error: () => {}, info: () => {} };

describe('Harness.runTurn (Phase 0 single-pass loop)', () => {
  let close: () => Promise<void>;
  let memory: TranscriptMemoryStore;
  let companion: CompanionDto;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    const identity = new DrizzleIdentityStore(created.db);
    memory = new TranscriptMemoryStore(created.db);
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
});

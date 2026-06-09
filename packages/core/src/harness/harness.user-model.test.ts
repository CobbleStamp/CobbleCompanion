/**
 * User-Model wiring in the agent loop (Phase 11, companion-memory.md §4): the
 * harness injects the user's Tier-1 core profile into the persona each turn and,
 * after the reply, captures explicit identity facts the user stated — so a fact
 * stated this turn is persisted and shapes the NEXT turn's persona (the DoD).
 */

import { type Database, EMBEDDING_DIMENSIONS, userFacts } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleUserModelStore } from '../user-model/store.js';
import { Harness } from './harness.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Script a reply turn that streams `text` and reports no tools. */
function reply(text: string): FakeTurn {
  return { chunks: [text] };
}

/** Script a capture turn reporting one fact (identity or belief) via report_user_facts. */
function capture(attribute: string, value: string): FakeTurn {
  return { toolCalls: [{ name: 'report_user_facts', args: { facts: [{ attribute, value }] } }] };
}

/** Drive a runTurn generator to completion (discarding events). */
async function drainTurn(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // events are streamed to the client; the test asserts side effects
  }
}

describe('Harness user-model wiring', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let userModel: DrizzleUserModelStore;
  let memory: TranscriptMemoryStore;
  let userId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    userModel = new DrizzleUserModelStore(db);
    memory = new TranscriptMemoryStore(db);
    const user = await identity.ensureUserByEmail('sam@example.com');
    userId = user.id;
  });

  afterEach(async () => {
    await close();
  });

  function makeHarness(turns: readonly FakeTurn[]): { harness: Harness; gateway: FakeLlmGateway } {
    const gateway = new FakeLlmGateway(turns);
    const harness = new Harness({
      gateway,
      memory,
      model: 'main',
      userModel: { store: userModel, model: 'cheap' },
      logger: silent,
    });
    return { harness, gateway };
  }

  it('injects the seeded name into the persona', async () => {
    await userModel.seedName(userId, 'Sam');
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    const { harness, gateway } = makeHarness([reply('Hi!')]);

    await drainTurn(harness.runTurn({ companion, userContent: 'hello', ownerId: userId }));

    // The reply call's persona system prompt addresses the user by their seeded name.
    expect(gateway.calls[0]?.messages[0]?.content).toContain('called Sam');
  });

  it('captures a stated fact and carries it into the next turn’s persona', async () => {
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    // Turn 1: reply, then a capture reporting livesIn=Berlin. Turn 2: reply, no capture.
    const { harness, gateway } = makeHarness([
      reply('Nice to meet you!'),
      capture('livesIn', 'Berlin'),
      reply('Berlin is lovely.'),
      { toolCalls: [{ name: 'report_user_facts', args: { facts: [] } }] },
    ]);

    await drainTurn(
      harness.runTurn({ companion, userContent: 'I live in Berlin', ownerId: userId }),
    );
    await harness.whenIdle(); // let the background capture settle

    // The stated fact was persisted as a current, transcript-sourced fact.
    const [row] = await db.select().from(userFacts).where(eq(userFacts.userId, userId));
    expect(row).toMatchObject({ predicate: 'livesIn', object: 'Berlin', source: 'transcript' });
    expect(row?.learnedByCompanionId).toBe(companion.id);
    // Inline capture records the companion link, not the exact turn seq (reserved, Phase 12).
    expect(row?.learnedFromSeq).toBeNull();

    // The NEXT turn's persona now reflects what was learned.
    await drainTurn(harness.runTurn({ companion, userContent: 'tell me more', ownerId: userId }));
    expect(gateway.calls[2]?.messages[0]?.content).toContain('lives in: Berlin');
  });

  it('captures an explicit belief as a Tier-2 belief, embedded, not into the persona', async () => {
    const embeddings = new FakeEmbeddingGateway();
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    const gateway = new FakeLlmGateway([
      reply('Jazz is wonderful!'),
      capture('interestedIn', 'jazz'),
      reply('More jazz.'),
      { toolCalls: [{ name: 'report_user_facts', args: { facts: [] } }] },
    ]);
    const harness = new Harness({
      gateway,
      memory,
      model: 'main',
      userModel: {
        store: userModel,
        model: 'cheap',
        embeddings,
        embeddingModel: 'embed',
        embeddingDimensions: EMBEDDING_DIMENSIONS,
      },
      logger: silent,
    });

    await drainTurn(harness.runTurn({ companion, userContent: 'I love jazz', ownerId: userId }));
    await harness.whenIdle();

    // Recorded as a current Tier-2 belief (not a Tier-1 identity fact), embedded.
    const beliefs = await userModel.listCurrentBeliefs(userId);
    expect(beliefs.map((b) => b.object)).toEqual(['jazz']);
    expect(beliefs[0]?.predicate).toBe('interestedIn');
    const [row] = await db.select().from(userFacts).where(eq(userFacts.id, beliefs[0]!.id));
    expect(row?.embedding).not.toBeNull();
    expect(embeddings.calls).toBe(1);

    // A belief never leaks into the every-turn persona (Tier-1 only).
    await drainTurn(harness.runTurn({ companion, userContent: 'hello', ownerId: userId }));
    expect(gateway.calls[2]?.messages[0]?.content).not.toContain('jazz');
  });

  it('does not capture or read the profile when no owner is provided', async () => {
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    await userModel.seedName(userId, 'Sam');
    const { harness, gateway } = makeHarness([reply('Hi!'), capture('livesIn', 'Berlin')]);

    // No ownerId → no user-model read/write (the harness can't scope per-user).
    await drainTurn(harness.runTurn({ companion, userContent: 'I live in Berlin' }));
    await harness.whenIdle();

    expect(gateway.calls[0]?.messages[0]?.content).not.toContain('called Sam');
    // Only the seeded name exists; nothing was captured.
    const current = await userModel.listCurrent(userId);
    expect(current.map((f) => f.predicate)).toEqual(['name']);
  });
});

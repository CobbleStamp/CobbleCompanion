/**
 * The User-Model Reflector (Phase 12, companion-memory.md §4): a background pass that
 * infers the user's IMPLICIT Tier-2 beliefs from the raw transcript window and reconciles
 * them against what's known — add / reinforce / supersede. Owns its cursor
 * (`userFactsThroughSeq`), self-gates, and never throws. Scripted LLM reads stand in for
 * the extract + reconcile passes; the store + cursor side effects are asserted.
 */

import { type Database, EMBEDDING_DIMENSIONS, userFacts } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { coerceBeliefs, coerceDecisions, LlmUserModelReflector } from './reflector.js';
import { DrizzleUserModelStore } from './store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Script the extract pass (report_user_beliefs). */
function extract(beliefs: readonly Record<string, unknown>[]): FakeTurn {
  return { toolCalls: [{ name: 'report_user_beliefs', args: { beliefs } }] };
}

/** Script the reconcile pass (report_reconciliation). */
function reconcile(decisions: readonly Record<string, unknown>[]): FakeTurn {
  return { toolCalls: [{ name: 'report_reconciliation', args: { decisions } }] };
}

describe('LlmUserModelReflector', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let store: DrizzleUserModelStore;
  let memory: TranscriptMemoryStore;
  let embeddings: FakeEmbeddingGateway;
  let userId: string;
  let companionId: string;

  function reflector(gateway: LlmGateway): LlmUserModelReflector {
    return new LlmUserModelReflector({
      identity,
      memory,
      store,
      llm: gateway,
      embeddings,
      model: 'cheap',
      embeddingModel: 'embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      logger: silent,
    });
  }

  /** Append `n` user turns so the window clears the min-turns gate. */
  async function seedTurns(n: number, text: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      await memory.appendMessage(companionId, 'user', `${text} (${i})`);
    }
  }

  /** Embed a belief's text so a pre-seeded belief is retrievable as a reconcile target. */
  async function embed(predicate: string, object: string): Promise<readonly number[]> {
    const { vectors } = await embeddings.embed({
      input: [`${predicate} ${object}`],
      model: 'embed',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const [vector] = vectors;
    if (!vector) {
      throw new Error('fake embedding returned no vector');
    }
    return vector;
  }

  async function cursor(): Promise<number> {
    const companion = await identity.getCompanionById(companionId);
    return companion?.userFactsThroughSeq ?? -1;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    store = new DrizzleUserModelStore(db);
    memory = new TranscriptMemoryStore(db);
    embeddings = new FakeEmbeddingGateway();
    const user = await identity.ensureUserByEmail('sam@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  it('derives an implicit belief from the window, stores it, advances the cursor', async () => {
    await seedTurns(6, 'how does async work in Rust');
    const gateway = new FakeLlmGateway([
      extract([{ attribute: 'interestedIn', value: 'Rust', confidence: 0.7 }]),
      reconcile([{ index: 0, op: 'add' }]),
    ]);

    await reflector(gateway).reflect(companionId);

    const beliefs = await store.listCurrentBeliefs(userId);
    expect(beliefs.map((b) => b.object)).toEqual(['Rust']);
    expect(beliefs[0]?.predicate).toBe('interestedIn');
    expect(await cursor()).toBeGreaterThan(0);
    // The reflector pins the transcript provenance the inline path can't.
    const [row] = await db.select().from(userFacts).where(eq(userFacts.id, beliefs[0]!.id));
    expect(row?.learnedFromSeq).toBeGreaterThan(0);
  });

  it('supersedes a same-matter newer state rather than duplicating it', async () => {
    const loves = await store.recordBelief({
      userId,
      predicate: 'prefers',
      object: 'loves coffee',
      embedding: await embed('prefers', 'loves coffee'),
    });
    await seedTurns(6, 'I quit coffee for good');
    const gateway = new FakeLlmGateway([
      extract([{ attribute: 'prefers', value: 'quit coffee' }]),
      reconcile([{ index: 0, op: 'supersede', targetId: loves.id }]),
    ]);

    await reflector(gateway).reflect(companionId);

    const current = await store.listCurrentBeliefs(userId);
    expect(current.map((b) => b.object)).toEqual(['quit coffee']);
    const [old] = await db.select().from(userFacts).where(eq(userFacts.id, loves.id));
    expect(old?.supersededAt).not.toBeNull();
  });

  it('reinforces an existing belief (salience bump, no new row)', async () => {
    const jazz = await store.recordBelief({
      userId,
      predicate: 'interestedIn',
      object: 'jazz',
      embedding: await embed('interestedIn', 'jazz'),
    });
    await seedTurns(6, 'more jazz please');
    const gateway = new FakeLlmGateway([
      extract([{ attribute: 'interestedIn', value: 'jazz' }]),
      reconcile([{ index: 0, op: 'reinforce', targetId: jazz.id }]),
    ]);

    await reflector(gateway).reflect(companionId);

    const current = await store.listCurrentBeliefs(userId);
    expect(current).toHaveLength(1);
    expect(current[0]?.salience).toBeCloseTo(0.6);
  });

  it('falls back to a fresh add when a reconcile target is stale', async () => {
    await seedTurns(6, 'I love hiking');
    const gateway = new FakeLlmGateway([
      extract([{ attribute: 'interestedIn', value: 'hiking' }]),
      reconcile([{ index: 0, op: 'supersede', targetId: 'does-not-exist' }]),
    ]);

    await reflector(gateway).reflect(companionId);

    expect((await store.listCurrentBeliefs(userId)).map((b) => b.object)).toEqual(['hiking']);
  });

  it('advances the cursor and writes nothing when no belief is inferred', async () => {
    await seedTurns(6, 'nice weather today');
    const gateway = new FakeLlmGateway([extract([])]);

    await reflector(gateway).reflect(companionId);

    expect(await store.listCurrentBeliefs(userId)).toEqual([]);
    expect(await cursor()).toBeGreaterThan(0);
    // Re-running is a no-op: the window past the advanced cursor is empty.
    await reflector(gateway).reflect(companionId);
    expect(await store.listCurrentBeliefs(userId)).toEqual([]);
  });

  it('does nothing below the min-turns threshold (no LLM call)', async () => {
    await seedTurns(3, 'hi');
    const gateway = new FakeLlmGateway([extract([{ attribute: 'interestedIn', value: 'x' }])]);

    await reflector(gateway).reflect(companionId);

    expect(gateway.calls).toHaveLength(0);
    expect(await store.listCurrentBeliefs(userId)).toEqual([]);
    expect(await cursor()).toBe(0);
  });

  it('never throws and leaves the cursor untouched on a gateway failure', async () => {
    await seedTurns(6, 'I love Rust');
    const broken: LlmGateway = {
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error('provider down');
      },
    };

    await expect(reflector(broken).reflect(companionId)).resolves.toBeUndefined();
    expect(await store.listCurrentBeliefs(userId)).toEqual([]);
    expect(await cursor()).toBe(0); // retried next time
  });
});

describe('coerceBeliefs', () => {
  it('keeps valid Tier-2 beliefs and drops junk', () => {
    expect(
      coerceBeliefs({
        beliefs: [
          { attribute: 'interestedIn', value: 'Rust', confidence: 0.7 },
          { attribute: 'name', value: 'Sam' }, // Tier-1, not a belief → dropped
          { attribute: 'prefers', value: '  ' }, // blank → dropped
          'nonsense',
        ],
      }),
    ).toEqual([{ predicate: 'interestedIn', object: 'Rust', confidence: 0.7 }]);
  });

  it('returns empty for a non-array beliefs field', () => {
    expect(coerceBeliefs({})).toEqual([]);
    expect(coerceBeliefs({ beliefs: 'nope' })).toEqual([]);
  });
});

describe('coerceDecisions', () => {
  it('keeps valid decisions and drops malformed ones', () => {
    expect(
      coerceDecisions({
        decisions: [
          { index: 0, op: 'add' },
          { index: 1, op: 'supersede', targetId: 'b1' },
          { index: 2, op: 'frobnicate' }, // invalid op → dropped
          { op: 'add' }, // no index → dropped
        ],
      }),
    ).toEqual([
      { index: 0, op: 'add' },
      { index: 1, op: 'supersede', targetId: 'b1' },
    ]);
  });
});

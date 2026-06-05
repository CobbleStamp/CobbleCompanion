/**
 * Harness affect path (Phase 4.2) — after a turn streams, the harness senses the
 * user's mood, stores the rolling read, and hands the turn-over-turn *change* to
 * `reinforce`. Perception runs in the loop (the body); learning is delegated (the
 * will). Best-effort: a sense failure never breaks the turn.
 */

import type { CompanionDto } from '@cobble/shared';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import type { AffectReading } from '../motivation/affect.js';
import { DrizzleCompanionAffectStore } from '../motivation/affect-store.js';
import { Harness, type HarnessAffect } from './harness.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Drain a runTurn generator to completion (so the post-stream affect work runs). */
async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    /* consume */
  }
}

describe('Harness perceiveAndLearn', () => {
  let close: () => Promise<void>;
  let memory: TranscriptMemoryStore;
  let affectStore: DrizzleCompanionAffectStore;
  let companion: CompanionDto;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    memory = new TranscriptMemoryStore(created.db);
    affectStore = new DrizzleCompanionAffectStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
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

  /** A gateway scripting the reply turn, then the affect read turn(s) — each a
   * `report_affect` tool call carrying the named valence + note. */
  function gateway(reply: string, ...affectReads: AffectReading[]): FakeLlmGateway {
    const turns: FakeTurn[] = [
      { chunks: [reply] },
      ...affectReads.map((r) => ({
        toolCalls: [{ name: 'report_affect', args: { valence: r.valence, note: r.note } }],
      })),
    ];
    return new FakeLlmGateway(turns);
  }

  function harnessWith(gw: FakeLlmGateway, affect: HarnessAffect): Harness {
    return new Harness({ gateway: gw, memory, model: 'chat-model', logger: silent, affect });
  }

  it('senses the user mood and stores the rolling read after the turn', async () => {
    const reinforce = vi.fn(async () => {});
    const harness = harnessWith(gateway('Hello!', { valence: 0.8, note: 'warm' }), {
      store: affectStore,
      model: 'cheap',
      reinforce,
    });

    await drain(harness.runTurn({ companion, userContent: 'you are the best', ownerId: 'owner' }));

    expect(await affectStore.get(companion.id)).toEqual({ valence: 0.8, note: 'warm' });
  });

  it('hands a zero delta to reinforce on the first turn (no baseline)', async () => {
    const reinforce = vi.fn(async (_companionId: string, _delta: number) => {});
    const harness = harnessWith(gateway('Hi', { valence: 0.7, note: 'pleased' }), {
      store: affectStore,
      model: 'cheap',
      reinforce,
    });

    await drain(harness.runTurn({ companion, userContent: 'hi', ownerId: 'owner' }));

    expect(reinforce).toHaveBeenCalledTimes(1);
    expect(reinforce.mock.calls[0]![1]).toBe(0); // first turn: delta 0
  });

  it('hands the turn-over-turn CHANGE to reinforce on the next turn', async () => {
    // Turn 1: user is cool (−0.5). Turn 2: user warms (+0.6) → delta +1.1.
    const t1 = harnessWith(gateway('ok', { valence: -0.5, note: 'cool' }), {
      store: affectStore,
      model: 'cheap',
    });
    await drain(t1.runTurn({ companion, userContent: 'whatever', ownerId: 'owner' }));

    const reinforce = vi.fn(async (_companionId: string, _delta: number) => {});
    const t2 = harnessWith(gateway('great', { valence: 0.6, note: 'warm' }), {
      store: affectStore,
      model: 'cheap',
      reinforce,
    });
    await drain(t2.runTurn({ companion, userContent: 'oh that is lovely', ownerId: 'owner' }));

    expect(reinforce).toHaveBeenCalledTimes(1);
    expect(reinforce.mock.calls[0]![1]).toBeCloseTo(1.1);
  });

  it('completes the turn even when the affect read fails (best-effort)', async () => {
    // Only one scripted turn → the second stream() (the affect read) returns an
    // empty reading; force a hard failure via a throwing reinforce instead.
    const reinforce = vi.fn(async () => {
      throw new Error('reinforce blew up');
    });
    const harness = harnessWith(gateway('Hello', { valence: 0.9, note: 'happy' }), {
      store: affectStore,
      model: 'cheap',
      reinforce,
    });

    const events: string[] = [];
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi',
      ownerId: 'owner',
    })) {
      events.push((event as { type: string }).type);
    }
    // The reply still completed with a terminal `done` despite reinforce throwing.
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  it('feeds the prior mood forward into the next reply prompt (fast-loop attunement)', async () => {
    // Turn 1 stores a "grumpy" read.
    const t1 = harnessWith(gateway('ok', { valence: -0.5, note: 'grumpy' }), {
      store: affectStore,
      model: 'cheap',
    });
    await drain(t1.runTurn({ companion, userContent: 'ugh fine', ownerId: 'owner' }));

    // Turn 2's reply call should carry an attunement system line built from it.
    const t2gw = gateway('better now', { valence: 0.2, note: 'neutral' });
    const t2 = harnessWith(t2gw, { store: affectStore, model: 'cheap' });
    await drain(t2.runTurn({ companion, userContent: 'hello again', ownerId: 'owner' }));

    const replyCall = t2gw.calls[0]!; // first stream() of turn 2 = the reply
    const systemText = replyCall.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('grumpy');
  });

  it('skips perception entirely when no affect deps are configured (pre-4.2 path)', async () => {
    const gw = new FakeLlmGateway([{ chunks: ['Hi'] }]);
    const harness = new Harness({ gateway: gw, memory, model: 'chat-model', logger: silent });
    await drain(harness.runTurn({ companion, userContent: 'hello', ownerId: 'owner' }));
    // Only the reply call was made — no second affect read.
    expect(gw.calls).toHaveLength(1);
    expect(await affectStore.get(companion.id)).toBeNull();
  });
});

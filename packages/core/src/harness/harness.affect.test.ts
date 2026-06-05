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
import type { LlmGateway, LlmMessage, LlmStreamParams, StreamResult } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import type { AffectReading } from '../motivation/affect.js';
import {
  DrizzleCompanionAffectStore,
  type CompanionAffectStore,
} from '../motivation/affect-store.js';
import { ZERO_USAGE } from '../usage.js';
import { Harness, type HarnessAffect } from './harness.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Drain a runTurn generator to completion (so the post-stream affect work runs). */
async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    /* consume */
  }
}

/** A resolvable promise, for gating an in-flight affect read. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Pull the fenced user text back out of a senseAffect prompt (`<user_message>…`). */
function fencedUserText(messages: readonly LlmMessage[]): string {
  const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  return (userMsg.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/)?.[1] ?? '').trim();
}

/**
 * Concurrency-safe gateway for the interleaving-turns test: responses are
 * addressed by message CONTENT, not call order, so two turns sharing one harness
 * can run with their stream() calls interleaved without scrambling a script. A
 * reply call (no report_affect tool) streams 'ok'; an affect read (the tool is
 * advertised) returns the valence keyed to its fenced user text. `onAffectRead`
 * lets a test observe / gate a specific read to widen the serialization window.
 */
class ContentAddressedGateway implements LlmGateway {
  constructor(
    private readonly affectByUserText: ReadonlyMap<string, AffectReading>,
    private readonly onAffectRead?: (userText: string) => Promise<void>,
  ) {}

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    const isAffectRead = (params.tools ?? []).some((t) => t.name === 'report_affect');
    if (!isAffectRead) {
      yield 'ok';
      return { usage: ZERO_USAGE, toolCalls: [] };
    }
    const userText = fencedUserText(params.messages);
    if (this.onAffectRead) {
      await this.onAffectRead(userText);
    }
    const reading = this.affectByUserText.get(userText);
    return {
      usage: ZERO_USAGE,
      toolCalls: reading
        ? [{ name: 'report_affect', args: { valence: reading.valence, note: reading.note } }]
        : [],
    };
  }
}

/** In-memory affect store that records the order of get/upsert ops across turns. */
class RecordingAffectStore implements CompanionAffectStore {
  readonly ops: string[] = [];
  private value: AffectReading | null = null;
  async get(): Promise<AffectReading | null> {
    this.ops.push(`get:${this.value ? this.value.valence : 'null'}`);
    return this.value;
  }
  async upsert(_companionId: string, reading: AffectReading): Promise<void> {
    this.ops.push(`upsert:${reading.valence}`);
    this.value = reading;
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
    await harness.whenIdle(); // the affect read is fire-and-forget; wait for it.

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
    await harness.whenIdle(); // the affect read is fire-and-forget; wait for it.

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
    await t1.whenIdle(); // turn 1's read must land before turn 2 reads its baseline.

    const reinforce = vi.fn(async (_companionId: string, _delta: number) => {});
    const t2 = harnessWith(gateway('great', { valence: 0.6, note: 'warm' }), {
      store: affectStore,
      model: 'cheap',
      reinforce,
    });
    await drain(t2.runTurn({ companion, userContent: 'oh that is lovely', ownerId: 'owner' }));
    await t2.whenIdle(); // the affect read is fire-and-forget; wait for it.

    expect(reinforce).toHaveBeenCalledTimes(1);
    expect(reinforce.mock.calls[0]![1]).toBeCloseTo(1.1);
  });

  it('keeps the prior baseline and does not learn when the read yields nothing', async () => {
    // Seed a prior read so we can prove it survives a non-read.
    await affectStore.upsert(companion.id, { valence: 0.8, note: 'warm' });
    const reinforce = vi.fn(async () => {});
    // Reply turn, then an affect read that returns prose (no report_affect call) —
    // senseAffect yields null, so the baseline must stay put and nothing is learned.
    const gw = new FakeLlmGateway([{ chunks: ['Hello'] }, { chunks: ['no tool call here'] }]);
    const harness = harnessWith(gw, { store: affectStore, model: 'cheap', reinforce });

    await drain(harness.runTurn({ companion, userContent: 'hi', ownerId: 'owner' }));
    await harness.whenIdle();

    expect(await affectStore.get(companion.id)).toEqual({ valence: 0.8, note: 'warm' });
    expect(reinforce).not.toHaveBeenCalled();
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
    await harness.whenIdle(); // let the throwing background read settle (self-caught).
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
    await t1.whenIdle(); // turn 1's read must land before turn 2 reads it forward.

    // Turn 2's reply call should carry an attunement system line built from it.
    const t2gw = gateway('better now', { valence: 0.2, note: 'neutral' });
    const t2 = harnessWith(t2gw, { store: affectStore, model: 'cheap' });
    await drain(t2.runTurn({ companion, userContent: 'hello again', ownerId: 'owner' }));
    await t2.whenIdle(); // let turn 2's background read settle before teardown.

    const replyCall = t2gw.calls[0]!; // first stream() of turn 2 = the reply
    const systemText = replyCall.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('grumpy');
  });

  it('still streams the reply when the prior-affect read throws (fast-loop best-effort)', async () => {
    // The turn-start `priorAffect` read feeds the last mood forward into the reply
    // prompt. If the store throws there, attunement is lost but the reply must not
    // break — the catch returns null and streaming proceeds normally.
    const throwingStore: HarnessAffect['store'] = {
      get: async (): Promise<AffectReading | null> => {
        throw new Error('store get blew up');
      },
      upsert: async (): Promise<void> => {},
    };
    const harness = harnessWith(gateway('Hello there', { valence: 0.5, note: 'calm' }), {
      store: throwingStore,
      model: 'cheap',
    });

    const events: string[] = [];
    const tokens: string[] = [];
    for await (const event of harness.runTurn({
      companion,
      userContent: 'hi',
      ownerId: 'owner',
    })) {
      const e = event as { type: string; value?: string };
      events.push(e.type);
      if (e.type === 'token' && e.value) {
        tokens.push(e.value);
      }
    }
    await harness.whenIdle(); // let any background read settle.

    // The thrown read did not break streaming: the reply token arrived and the
    // turn terminated cleanly.
    expect(tokens.join('')).toBe('Hello there');
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  it('serializes the affect read per companion so a follow-up turn sees the prior upsert', async () => {
    // Two turns through ONE harness instance (the per-instance chain is what
    // serializes them — in production there is one harness per process). Turn 1's
    // affect read is held open; if the read were NOT serialized, turn 2 would read
    // its baseline before turn 1's upsert lands — both capture the same prior, and
    // turn 2's delta double-counts (here: would be 0 against a null baseline). The
    // chain must keep turn 2's read queued until turn 1's upsert has committed.
    const store = new RecordingAffectStore();
    const reachedTurn1 = deferred();
    const releaseTurn1 = deferred();
    let gatedTurn1 = false;
    const gateway = new ContentAddressedGateway(
      new Map([
        ['turn one', { valence: -0.5, note: 'cool' }],
        ['turn two', { valence: 0.6, note: 'warm' }],
      ]),
      async (userText) => {
        // Hold ONLY turn 1's read open, once, to widen the race window.
        if (userText === 'turn one' && !gatedTurn1) {
          gatedTurn1 = true;
          reachedTurn1.resolve();
          await releaseTurn1.promise;
        }
      },
    );
    const reinforce = vi.fn(async (_companionId: string, _delta: number) => {});
    const harness = new Harness({
      gateway,
      memory,
      model: 'chat-model',
      logger: silent,
      affect: { store, model: 'cheap', reinforce },
    });

    // Turn 1: reply streams, then its background affect read starts and blocks at
    // the gate (after its perceive-get, before its upsert).
    await drain(harness.runTurn({ companion, userContent: 'turn one', ownerId: 'owner' }));
    await reachedTurn1.promise;

    // Turn 2: reply streams; its affect read is chained behind turn 1's. Turn 2's
    // own read is NOT gated, so without serialization it would run to completion
    // here and upsert 0.6 while turn 1 is still blocked. The chain must keep it
    // queued: no upsert and no learning has happened yet. (Each turn's prepare()
    // also does an attunement get — those are not part of the serialized chain, so
    // assert on upserts/reinforce, the chain's effects, not raw get count.)
    await drain(harness.runTurn({ companion, userContent: 'turn two', ownerId: 'owner' }));
    expect(store.ops.filter((o) => o.startsWith('upsert'))).toEqual([]);
    expect(reinforce).not.toHaveBeenCalled();

    // Release turn 1; both reads now settle in order.
    releaseTurn1.resolve();
    await harness.whenIdle();

    // Strict ordering: turn 1 commits (-0.5) before turn 2's read, which therefore
    // sees -0.5 and writes 0.6 — never the reverse, and never two writes off null.
    expect(store.ops.filter((o) => o.startsWith('upsert'))).toEqual(['upsert:-0.5', 'upsert:0.6']);
    // Turn 1: first turn, no baseline → delta 0. Turn 2: 0.6 − (−0.5) = 1.1, which
    // is only correct because it read turn 1's committed value (not a stale null,
    // which the `?? reading.valence` first-turn rule would have collapsed to 0).
    expect(reinforce).toHaveBeenCalledTimes(2);
    expect(reinforce.mock.calls[0]![1]).toBe(0);
    expect(reinforce.mock.calls[1]![1]).toBeCloseTo(1.1);
  });

  it('skips perception entirely when no affect deps are configured (pre-4.2 path)', async () => {
    const gw = new FakeLlmGateway([{ chunks: ['Hi'] }]);
    const harness = new Harness({ gateway: gw, memory, model: 'chat-model', logger: silent });
    await drain(harness.runTurn({ companion, userContent: 'hello', ownerId: 'owner' }));
    await harness.whenIdle(); // no affect deps → the background task is a no-op.
    // Only the reply call was made — no second affect read.
    expect(gw.calls).toHaveLength(1);
    expect(await affectStore.get(companion.id)).toBeNull();
  });
});

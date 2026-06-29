/**
 * PostTurnPerception unit tests — the extracted post-turn affect read + user-fact
 * capture (Phase 4.2 / 11–12). These exercise the class DIRECTLY (no Harness, no agent
 * loop) with in-memory fakes, so they need NO database. The high-value assertions are
 * the per-key serialization chains (affect per companion, user-facts per user) and the
 * best-effort error swallow.
 *
 * Gating strategy: both senseAffect and captureUserFacts fence the user's text in
 * `<user_message>…</user_message>`. A single content-addressed gateway shared across
 * calls keys its responses (and an optional async gate) on that fenced text, so two
 * afterTurn() calls through one PostTurnPerception can have their stream() calls
 * interleaved without scrambling a call-order script — letting us hold one read open to
 * observe whether a second is serialized behind it.
 */

import type { MessageDto } from '@cobble/shared';
import { describe, expect, it, vi } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { LlmGateway, LlmMessage, LlmStreamParams, StreamResult } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { AffectReading } from '../motivation/affect.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import { REPORT_AFFECT, REPORT_USER_FACTS } from '../prompts/index.js';
import { ZERO_USAGE } from '../usage.js';
import type {
  RecordBeliefInput,
  RecordTranscriptFactInput,
  UserModelStore,
} from '../user-model/store.js';
import { PostTurnPerception } from './post-turn-perception.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A resolvable promise, for gating an in-flight read to widen the serialization window. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Pull the fenced user text back out of a read's prompt (`<user_message>…`). */
function fencedUserText(messages: readonly LlmMessage[]): string {
  const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  return (userMsg.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/)?.[1] ?? '').trim();
}

/** A minimal recent-transcript snapshot — one conversational user turn (so affectContext
 *  yields something non-empty after dropping the final turn isn't needed; the read only
 *  needs a userText). */
function snapshotOf(userContent: string): readonly MessageDto[] {
  return [
    { role: 'user', content: userContent, seq: 1, createdAt: new Date().toISOString() },
  ] as unknown as readonly MessageDto[];
}

/**
 * Content-addressed gateway: responds by the fenced user text rather than call order, so
 * interleaved reads from two afterTurn() calls don't scramble a script. An affect read
 * (the `report_affect` tool is advertised) returns the keyed valence; a user-fact read
 * (`report_user_facts`) returns the keyed candidate facts. `onRead(kind, userText)` lets
 * a test gate/observe a specific read.
 */
class ContentAddressedGateway implements LlmGateway {
  readonly affectReads: string[] = [];
  readonly factReads: string[] = [];

  constructor(
    private readonly affectByUserText: ReadonlyMap<string, AffectReading>,
    private readonly factsByUserText: ReadonlyMap<
      string,
      readonly { attribute: string; value: string }[]
    >,
    private readonly onRead?: (kind: 'affect' | 'facts', userText: string) => Promise<void> | void,
  ) {}

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    const tools = params.tools ?? [];
    const userText = fencedUserText(params.messages);
    if (tools.some((t) => t.name === REPORT_AFFECT)) {
      this.affectReads.push(userText);
      if (this.onRead) {
        await this.onRead('affect', userText);
      }
      const reading = this.affectByUserText.get(userText);
      return {
        usage: ZERO_USAGE,
        toolCalls: reading
          ? [{ name: REPORT_AFFECT, args: { valence: reading.valence, note: reading.note } }]
          : [],
      };
    }
    if (tools.some((t) => t.name === REPORT_USER_FACTS)) {
      this.factReads.push(userText);
      if (this.onRead) {
        await this.onRead('facts', userText);
      }
      const facts = this.factsByUserText.get(userText) ?? [];
      return { usage: ZERO_USAGE, toolCalls: [{ name: REPORT_USER_FACTS, args: { facts } }] };
    }
    yield 'ok';
    return { usage: ZERO_USAGE, toolCalls: [] };
  }
}

/** In-memory affect store recording the order of get/upsert ops, keyed per companion. */
class RecordingAffectStore implements CompanionAffectStore {
  readonly ops: string[] = [];
  private readonly values = new Map<string, AffectReading>();
  async get(companionId: string): Promise<AffectReading | null> {
    const v = this.values.get(companionId) ?? null;
    this.ops.push(`get:${companionId}:${v ? v.valence : 'null'}`);
    return v;
  }
  async upsert(companionId: string, reading: AffectReading): Promise<void> {
    this.ops.push(`upsert:${companionId}:${reading.valence}`);
    this.values.set(companionId, reading);
  }
}

/** In-memory user-model store recording the order of fact writes, keyed per user. */
class RecordingUserModelStore implements UserModelStore {
  readonly ops: string[] = [];
  async recordTranscriptFact(input: RecordTranscriptFactInput): Promise<never> {
    this.ops.push(`fact:${input.userId}:${input.predicate}=${input.object}`);
    return undefined as never;
  }
  async recordBelief(input: RecordBeliefInput): Promise<never> {
    this.ops.push(`belief:${input.userId}:${input.predicate}=${input.object}`);
    return undefined as never;
  }
  // Unused boundary methods — this test only drives capture writes.
  async listCurrent(): Promise<never[]> {
    return [];
  }
  async seedName(): Promise<null> {
    return null;
  }
  async editFact(): Promise<null> {
    return null;
  }
  async deleteFact(): Promise<boolean> {
    return false;
  }
  async listCurrentBeliefs(): Promise<never[]> {
    return [];
  }
  async searchBeliefs(): Promise<never[]> {
    return [];
  }
  async findSimilarBeliefs(): Promise<never[]> {
    return [];
  }
  async adjustBeliefSalience(): Promise<null> {
    return null;
  }
  async replaceBelief(): Promise<null> {
    return null;
  }
}

describe('PostTurnPerception.needsSnapshot', () => {
  const gateway = new FakeLlmGateway([{ chunks: ['ok'] }]);
  const affect = { store: new RecordingAffectStore(), model: 'cheap' };
  const userModel = { store: new RecordingUserModelStore(), model: 'cheap' };

  it('is true when affect is wired, regardless of ownerId', () => {
    const p = new PostTurnPerception({ gateway, logger: silent, affect });
    expect(p.needsSnapshot('owner')).toBe(true);
    expect(p.needsSnapshot(undefined)).toBe(true);
  });

  it('is true when userModel is wired AND ownerId is defined', () => {
    const p = new PostTurnPerception({ gateway, logger: silent, userModel });
    expect(p.needsSnapshot('owner')).toBe(true);
  });

  it('is false when only userModel is wired but ownerId is undefined (no user to key)', () => {
    const p = new PostTurnPerception({ gateway, logger: silent, userModel });
    expect(p.needsSnapshot(undefined)).toBe(false);
  });

  it('is false when neither affect nor userModel is wired', () => {
    const p = new PostTurnPerception({ gateway, logger: silent });
    expect(p.needsSnapshot('owner')).toBe(false);
    expect(p.needsSnapshot(undefined)).toBe(false);
  });
});

describe('PostTurnPerception affect serialization (per companion)', () => {
  it('serializes the affect chain for the SAME companion (second read starts only after the first resolves)', async () => {
    const store = new RecordingAffectStore();
    const reached = deferred();
    const release = deferred();
    let gated = false;
    const gateway = new ContentAddressedGateway(
      new Map([
        ['turn one', { valence: -0.5, note: 'cool' }],
        ['turn two', { valence: 0.6, note: 'warm' }],
      ]),
      new Map(),
      async (kind, userText) => {
        // Hold ONLY turn one's affect read open, once, after its get and before its upsert.
        if (kind === 'affect' && userText === 'turn one' && !gated) {
          gated = true;
          reached.resolve();
          await release.promise;
        }
      },
    );
    const reinforce = vi.fn(async (_companionId: string, _delta: number) => {});
    const perception = new PostTurnPerception({
      gateway,
      logger: silent,
      affect: { store, model: 'cheap', reinforce },
    });

    // Turn 1: its affect read starts and blocks at the gate (after get, before upsert).
    const t1Tasks = perception.afterTurn({
      companionId: 'comp',
      userContent: 'turn one',
      snapshot: snapshotOf('turn one'),
    });
    await reached.promise;

    // Turn 2 (same companion): chained behind turn 1. Its read is NOT gated, so without
    // serialization it would run to completion here and upsert 0.6 while turn 1 is still
    // blocked. The chain must keep it queued: no upsert, no second affect read yet.
    const t2Tasks = perception.afterTurn({
      companionId: 'comp',
      userContent: 'turn two',
      snapshot: snapshotOf('turn two'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.ops.filter((o) => o.startsWith('upsert'))).toEqual([]);
    expect(gateway.affectReads).toEqual(['turn one']); // turn 2's read has not begun
    expect(reinforce).not.toHaveBeenCalled();

    // Release turn 1; both reads settle in strict order.
    release.resolve();
    await Promise.all([...t1Tasks, ...t2Tasks]);

    expect(store.ops.filter((o) => o.startsWith('upsert'))).toEqual([
      'upsert:comp:-0.5',
      'upsert:comp:0.6',
    ]);
    expect(gateway.affectReads).toEqual(['turn one', 'turn two']);
    // Turn 1: first turn, no baseline → delta 0. Turn 2 reads turn 1's committed −0.5 →
    // delta 0.6 − (−0.5) = 1.1 — only correct because it ran AFTER turn 1's upsert.
    expect(reinforce).toHaveBeenCalledTimes(2);
    expect(reinforce.mock.calls[0]![1]).toBe(0);
    expect(reinforce.mock.calls[1]![1]).toBeCloseTo(1.1);
  });

  it('allows affect reads for DIFFERENT companions to overlap (independent chains)', async () => {
    const store = new RecordingAffectStore();
    const reachedA = deferred();
    const release = deferred();
    let gated = false;
    const gateway = new ContentAddressedGateway(
      new Map([
        ['turn a', { valence: 0.1, note: 'a' }],
        ['turn b', { valence: 0.2, note: 'b' }],
      ]),
      new Map(),
      async (kind, userText) => {
        // Hold companion A's read open; companion B (a different key) must still proceed.
        if (kind === 'affect' && userText === 'turn a' && !gated) {
          gated = true;
          reachedA.resolve();
          await release.promise;
        }
      },
    );
    const perception = new PostTurnPerception({
      gateway,
      logger: silent,
      affect: { store, model: 'cheap' },
    });

    const aTasks = perception.afterTurn({
      companionId: 'A',
      userContent: 'turn a',
      snapshot: snapshotOf('turn a'),
    });
    await reachedA.promise; // A is blocked mid-read

    // B is a different companion → a different chain → it runs to completion while A waits.
    const bTasks = perception.afterTurn({
      companionId: 'B',
      userContent: 'turn b',
      snapshot: snapshotOf('turn b'),
    });
    await Promise.all([...bTasks]);
    expect(store.ops.filter((o) => o === 'upsert:B:0.2')).toEqual(['upsert:B:0.2']);
    // A is still blocked — its upsert has not happened.
    expect(store.ops.some((o) => o.startsWith('upsert:A'))).toBe(false);

    release.resolve();
    await Promise.all([...aTasks]);
    expect(store.ops.some((o) => o === 'upsert:A:0.1')).toBe(true);
  });
});

describe('PostTurnPerception user-fact capture serialization (per user)', () => {
  it('serializes the user-fact chain for the SAME user (second capture starts only after the first resolves)', async () => {
    const userStore = new RecordingUserModelStore();
    const reached = deferred();
    const release = deferred();
    let gated = false;
    const gateway = new ContentAddressedGateway(
      new Map(),
      new Map([
        ['turn one', [{ attribute: 'name', value: 'Ada' }]],
        ['turn two', [{ attribute: 'livesIn', value: 'Paris' }]],
      ]),
      async (kind, userText) => {
        // Hold turn one's capture read open after the read starts and before its writes.
        if (kind === 'facts' && userText === 'turn one' && !gated) {
          gated = true;
          reached.resolve();
          await release.promise;
        }
      },
    );
    const perception = new PostTurnPerception({
      gateway,
      logger: silent,
      userModel: { store: userStore, model: 'cheap' },
    });

    // Turn 1: capture read for user "u1" blocks at the gate.
    const t1Tasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'u1',
      userContent: 'turn one',
      snapshot: snapshotOf('turn one'),
    });
    await reached.promise;

    // Turn 2 (SAME user u1): chained behind turn 1. Its read must not begin while turn 1
    // is held — no second read, no writes yet.
    const t2Tasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'u1',
      userContent: 'turn two',
      snapshot: snapshotOf('turn two'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(userStore.ops).toEqual([]); // turn 1 blocked before its write
    expect(gateway.factReads).toEqual(['turn one']); // turn 2's read has not begun

    release.resolve();
    await Promise.all([...t1Tasks, ...t2Tasks]);

    // Strict ordering: turn 1's fact is written before turn 2's read even runs.
    expect(gateway.factReads).toEqual(['turn one', 'turn two']);
    expect(userStore.ops).toEqual(['fact:u1:name=Ada', 'fact:u1:livesIn=Paris']);
  });

  it('allows user-fact captures for DIFFERENT users to overlap (independent chains)', async () => {
    const userStore = new RecordingUserModelStore();
    const reachedA = deferred();
    const release = deferred();
    let gated = false;
    const gateway = new ContentAddressedGateway(
      new Map(),
      new Map([
        ['turn a', [{ attribute: 'name', value: 'Alice' }]],
        ['turn b', [{ attribute: 'name', value: 'Bob' }]],
      ]),
      async (kind, userText) => {
        if (kind === 'facts' && userText === 'turn a' && !gated) {
          gated = true;
          reachedA.resolve();
          await release.promise;
        }
      },
    );
    const perception = new PostTurnPerception({
      gateway,
      logger: silent,
      userModel: { store: userStore, model: 'cheap' },
    });

    const aTasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'userA',
      userContent: 'turn a',
      snapshot: snapshotOf('turn a'),
    });
    await reachedA.promise; // user A's capture is blocked mid-read

    // User B is a different user → a different chain → it completes while A waits.
    const bTasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'userB',
      userContent: 'turn b',
      snapshot: snapshotOf('turn b'),
    });
    await Promise.all([...bTasks]);
    expect(userStore.ops).toEqual(['fact:userB:name=Bob']);

    release.resolve();
    await Promise.all([...aTasks]);
    expect(userStore.ops).toContain('fact:userA:name=Alice');
  });

  it('routes a Tier-2 belief to recordBelief and a Tier-1 attribute to recordTranscriptFact', async () => {
    const userStore = new RecordingUserModelStore();
    const gateway = new ContentAddressedGateway(
      new Map(),
      new Map([
        [
          'mixed',
          [
            { attribute: 'name', value: 'Ada' }, // Tier-1 identity → recordTranscriptFact
            { attribute: 'prefers', value: 'tea' }, // Tier-2 belief → recordBelief
          ],
        ],
      ]),
    );
    const perception = new PostTurnPerception({
      gateway,
      logger: silent,
      userModel: { store: userStore, model: 'cheap' },
    });

    const tasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'u1',
      userContent: 'mixed',
      snapshot: snapshotOf('mixed'),
    });
    await Promise.all([...tasks]);

    expect(userStore.ops).toContain('fact:u1:name=Ada');
    expect(userStore.ops).toContain('belief:u1:prefers=tea');
  });
});

describe('PostTurnPerception best-effort error swallow', () => {
  it('settles the affect task without throwing AND logs harness.perceiveAndLearn on store failure', async () => {
    const error = vi.fn();
    const logger: Logger = { error, warn: () => {}, info: () => {} };
    // A store whose get() throws hard inside perceiveAndLearn → caught + logged, task settles.
    const throwingStore: CompanionAffectStore = {
      get: async () => {
        throw new Error('store get blew up');
      },
      upsert: async () => {},
    };
    const gateway = new ContentAddressedGateway(
      new Map([['boom', { valence: 0.5, note: 'x' }]]),
      new Map(),
    );
    const perception = new PostTurnPerception({
      gateway,
      logger,
      affect: { store: throwingStore, model: 'cheap' },
    });

    const tasks = perception.afterTurn({
      companionId: 'comp',
      userContent: 'boom',
      snapshot: snapshotOf('boom'),
    });
    // The chained task resolves (does not reject) despite the inner throw.
    await expect(Promise.all([...tasks])).resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('failed to perceive/learn user affect');
    expect(error.mock.calls[0]![1]).toMatchObject({ operation: 'harness.perceiveAndLearn' });
  });

  it('settles the capture task without throwing AND logs harness.captureUserFacts on store failure', async () => {
    const error = vi.fn();
    const logger: Logger = { error, warn: () => {}, info: () => {} };
    // A user-model store whose recordTranscriptFact throws → captureAndStore catches + logs.
    const throwingStore = new RecordingUserModelStore();
    throwingStore.recordTranscriptFact = async () => {
      throw new Error('record blew up');
    };
    const gateway = new ContentAddressedGateway(
      new Map(),
      new Map([['boom', [{ attribute: 'name', value: 'Ada' }]]]),
    );
    const perception = new PostTurnPerception({
      gateway,
      logger,
      userModel: { store: throwingStore, model: 'cheap' },
    });

    const tasks = perception.afterTurn({
      companionId: 'comp',
      ownerId: 'u1',
      userContent: 'boom',
      snapshot: snapshotOf('boom'),
    });
    await expect(Promise.all([...tasks])).resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('failed to capture/store user facts');
    expect(error.mock.calls[0]![1]).toMatchObject({ operation: 'harness.captureUserFacts' });
  });
});

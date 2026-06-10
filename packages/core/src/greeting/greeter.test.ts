/**
 * Greeting service (Phase 14) — the branches the route DoD can't reach
 * deterministically, driven with fakes: which open loop is picked up, how known
 * things are ranked and formatted, and what a failed voicing does to billing.
 * The pure gate lives in decide.test.ts; the end-to-end DoD in the route test.
 */

import type { Drive, MessageDto, MessageRole, UserFactDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import type { LlmGateway } from '../llm/gateway.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { LlmGatewayError } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { CompanionRecord, IdentityStore } from '../identity/store.js';
import type { MemoryStore } from '../memory/store.js';
import type {
  ProactiveOutcomeRecord,
  ProactiveOutcomeStore,
  RecordOutcomeInput,
} from '../motivation/reward-store.js';
import type { ProposalRecord, ProposalStore } from '../tools/proposal-store.js';
import type { UserModelStore } from '../user-model/store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { GreetingService, type GreetingServiceDeps, describeGap } from './greeter.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

const NOW = new Date('2026-01-02T12:00:00.000Z');
const DAY_AGO = new Date('2026-01-01T12:00:00.000Z'); // a 24h gap → active/gentle greet

// --- Record factories -------------------------------------------------------

function companionRecord(overrides: Partial<CompanionRecord> = {}): CompanionRecord {
  return {
    id: 'companion-1',
    ownerId: 'owner-1',
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    evolvedPersona: null,
    personaUpdatedThroughSeq: 0,
    consolidatedThroughSeq: 0,
    userFactsThroughSeq: 0,
    userPersona: null,
    userModelUpdatedThroughSeq: 0,
    proactivityDial: 'active',
    personalityKnobs: null,
    driveWeights: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: DAY_AGO.toISOString(),
    ...overrides,
  };
}

function message(role: MessageRole, content: string): MessageDto {
  return {
    id: 'm1',
    companionId: 'companion-1',
    sourceId: null,
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function belief(
  object: string,
  salience: number | null,
  predicate: string | null = null,
): UserFactDto {
  return {
    id: `f-${object}`,
    source: 'transcript',
    factType: 'belief',
    subject: 'user',
    predicate,
    object,
    confidence: null,
    salience,
    sensitive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function proposal(summary: string): ProposalRecord {
  return {
    id: `p-${summary}`,
    companionId: 'companion-1',
    toolName: 'ingest_source',
    toolArgs: {},
    toolCallId: null,
    summary,
    status: 'pending',
    leadId: null,
    origin: 'chat',
    createdAt: DAY_AGO,
    resolvedAt: null,
  };
}

// --- Fakes (only the methods the greeter touches) ---------------------------

class FakeIdentity {
  readonly markSeenCalls: Date[] = [];
  constructor(private readonly record: CompanionRecord | null) {}
  async getCompanionById(): Promise<CompanionRecord | null> {
    return this.record;
  }
  async markSeen(_companionId: string, at: Date): Promise<void> {
    this.markSeenCalls.push(at);
  }
}

class FakeMemory {
  readonly appended: { role: MessageRole; content: string }[] = [];
  constructor(private readonly recent: readonly MessageDto[] = []) {}
  async getRecentMessages(): Promise<readonly MessageDto[]> {
    return this.recent;
  }
  async appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
  ): Promise<MessageDto> {
    this.appended.push({ role, content });
    return { ...message(role, content), id: `appended-${this.appended.length}`, companionId };
  }
}

class FakeProposals {
  constructor(private readonly pending: readonly ProposalRecord[] = []) {}
  async listPending(): Promise<readonly ProposalRecord[]> {
    return this.pending;
  }
}

class FakeRewards {
  readonly recorded: Drive[] = [];
  constructor(private readonly unresolved: ProactiveOutcomeRecord | null = null) {}
  async findLatestUnresolved(): Promise<ProactiveOutcomeRecord | null> {
    return this.unresolved;
  }
  async record(_companionId: string, input: RecordOutcomeInput): Promise<ProactiveOutcomeRecord> {
    this.recorded.push(input.drive);
    return {
      id: 'recorded',
      companionId: 'companion-1',
      noteMessageId: input.noteMessageId ?? null,
      proposalId: null,
      drive: input.drive,
      drivenByUserFactId: null,
      reward: null,
      createdAt: NOW,
      resolvedAt: null,
    };
  }
}

class FakeUserModel {
  constructor(private readonly beliefs: readonly UserFactDto[] = []) {}
  async listCurrentBeliefs(): Promise<readonly UserFactDto[]> {
    return this.beliefs;
  }
}

class FakeStamina {
  readonly spends: number[] = [];
  constructor(private readonly empty = false) {}
  async isEmpty(): Promise<boolean> {
    return this.empty;
  }
  async spend(_companionId: string, tokens: number): Promise<void> {
    this.spends.push(tokens);
  }
}

interface Harness {
  readonly service: GreetingService;
  readonly identity: FakeIdentity;
  readonly memory: FakeMemory;
  readonly rewards: FakeRewards;
  readonly stamina: FakeStamina;
}

function makeService(
  opts: {
    companion?: CompanionRecord | null;
    recent?: readonly MessageDto[];
    pending?: readonly ProposalRecord[];
    unresolved?: ProactiveOutcomeRecord | null;
    beliefs?: readonly UserFactDto[];
    staminaEmpty?: boolean;
    llm?: LlmGateway;
  } = {},
): Harness {
  const identity = new FakeIdentity(
    opts.companion === undefined ? companionRecord() : opts.companion,
  );
  const memory = new FakeMemory(opts.recent);
  const proposals = new FakeProposals(opts.pending);
  const rewards = new FakeRewards(opts.unresolved ?? null);
  const userModel = new FakeUserModel(opts.beliefs);
  const stamina = new FakeStamina(opts.staminaEmpty ?? false);
  const llm = opts.llm ?? new FakeLlmGateway(['Hello there']);
  const deps: GreetingServiceDeps = {
    identity: identity as unknown as IdentityStore,
    memory: memory as unknown as MemoryStore,
    proposals: proposals as unknown as ProposalStore,
    rewards: rewards as unknown as ProactiveOutcomeStore,
    userModel: userModel as unknown as UserModelStore,
    stamina: stamina as unknown as VitalityStore,
    llm,
    model: 'test-model',
    logger: silent,
  };
  const service = new GreetingService(deps, { now: () => NOW });
  return { service, identity, memory, rewards, stamina };
}

/** prepare() and assert it decided to act, returning the acting plan. */
async function prepareActing(h: Harness) {
  const plan = await h.service.prepare('companion-1', 'owner-1');
  if (!plan.act) throw new Error('expected the gate to greet');
  return plan;
}

describe('GreetingService.prepare — open loop', () => {
  it('picks up an unanswered question (last assistant turn ends with "?")', async () => {
    const h = makeService({
      recent: [message('assistant', 'So how did the interview go?')],
    });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toContain('a question you left them with');
    expect(plan.voice.openLoop).toContain('how did the interview go?');
  });

  it('ignores a last assistant turn that is not a question', async () => {
    const h = makeService({ recent: [message('assistant', 'Glad I could help.')] });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toBeNull();
  });

  it('ignores a trailing question from the USER (only the companion leaves loops)', async () => {
    const h = makeService({ recent: [message('user', 'are you there?')] });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toBeNull();
  });

  it('prefers a pending approval over an unanswered question', async () => {
    const h = makeService({
      pending: [proposal('read example.com into memory')],
      recent: [message('assistant', 'Shall I summarize it for you?')],
    });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toContain('waiting for your approval');
    expect(plan.voice.openLoop).toContain('read example.com into memory');
  });

  it('counts the extra pending approvals beyond the first', async () => {
    const h = makeService({
      pending: [proposal('read A'), proposal('read B'), proposal('read C')],
    });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toContain('(and 2 more)');
  });

  it('truncates a very long unanswered question', async () => {
    const longQuestion = `${'q'.repeat(300)}?`;
    const h = makeService({ recent: [message('assistant', longQuestion)] });
    const plan = await prepareActing(h);
    expect(plan.voice.openLoop).toContain('…');
    expect(plan.voice.openLoop!.length).toBeLessThan(longQuestion.length);
  });
});

describe('GreetingService.prepare — known things', () => {
  it('keeps the two strongest beliefs, by salience, strongest first', async () => {
    const h = makeService({
      beliefs: [
        belief('plays guitar', 0.2),
        belief('Rust', 0.9, 'interestedIn'),
        belief('lives in Berlin', 0.5),
      ],
    });
    const plan = await prepareActing(h);
    // Top two by salience: Rust (0.9, predicate-formatted) then "lives in Berlin" (0.5).
    expect(plan.voice.knownThings).toEqual(['interestedIn Rust', 'lives in Berlin']);
  });

  it('treats a null salience as the weakest', async () => {
    const h = makeService({
      beliefs: [belief('a', null), belief('b', 0.1), belief('c', 0.4)],
    });
    const plan = await prepareActing(h);
    expect(plan.voice.knownThings).toEqual(['c', 'b']); // 'a' (null) drops off
  });

  it('knows nothing on a first meeting (never pretends)', async () => {
    const h = makeService({
      companion: companionRecord({ lastSeenAt: null }),
      beliefs: [belief('Rust', 0.9, 'interestedIn')],
    });
    const plan = await prepareActing(h);
    expect(plan.move.kind).toBe('introduce');
    expect(plan.voice.knownThings).toEqual([]);
    expect(plan.voice.gapPhrase).toBeNull();
  });
});

describe('GreetingService.compose — voicing failure (billing-crash-compensation)', () => {
  it('a mid-stream provider fault: no message, no reward, and NOT billed', async () => {
    const throwing: LlmGateway = {
      // eslint-disable-next-line require-yield -- a throw before completion is the point
      async *stream() {
        yield 'Hel';
        throw new LlmGatewayError('provider exploded mid-stream');
      },
    };
    const h = makeService({ llm: throwing });
    const plan = await prepareActing(h);
    const result = await h.service.compose('companion-1', plan);

    expect(result.ok).toBe(false);
    expect(h.memory.appended).toHaveLength(0); // no turn persisted
    expect(h.rewards.recorded).toHaveLength(0); // nothing to reward
    // Our infra fault is unmetered — we eat it rather than bill the user.
    expect(h.stamina.spends).toHaveLength(0);
  });

  it('an empty generation: no message, no reward — but the consumed tokens ARE billed', async () => {
    // A clean completion that yields no text still spent prompt tokens at the
    // provider, so it bills (unlike a fault) even though nothing is shown.
    const h = makeService({ llm: new FakeLlmGateway(['']) });
    const plan = await prepareActing(h);
    const result = await h.service.compose('companion-1', plan);

    expect(result.ok).toBe(false);
    expect(h.memory.appended).toHaveLength(0);
    expect(h.rewards.recorded).toHaveLength(0);
    expect(h.stamina.spends).toHaveLength(1);
    expect(h.stamina.spends[0]).toBeGreaterThan(0);
  });
});

describe('GreetingService.compose — success and exhaustion', () => {
  it('voices, persists, rewards a bond outcome, and bills stamina', async () => {
    const h = makeService({ llm: new FakeLlmGateway(['Hey, ', 'good to see you']) });
    const plan = await prepareActing(h);
    const result = await h.service.compose('companion-1', plan);

    expect(result.ok && result.message.content).toBe('Hey, good to see you');
    expect(h.memory.appended).toEqual([{ role: 'assistant', content: 'Hey, good to see you' }]);
    expect(h.rewards.recorded).toEqual(['bond']);
    expect(h.stamina.spends[0]).toBeGreaterThan(0);
  });

  it('an exhausted companion shows the fixed line: no LLM call, no reward', async () => {
    const h = makeService({ staminaEmpty: true });
    const plan = await prepareActing(h);
    expect(plan.exhausted).toBe(true);
    const result = await h.service.compose('companion-1', plan);

    expect(result.ok && result.message.content).toContain('Feed me');
    expect(h.rewards.recorded).toHaveLength(0); // a forced groan isn't a drive-serving act
    expect(h.stamina.spends).toHaveLength(0); // token-free
  });
});

describe('GreetingService.prepare — gating', () => {
  it('stays quiet when the companion is gone', async () => {
    const h = makeService({ companion: null });
    expect((await h.service.prepare('companion-1', 'owner-1')).act).toBe(false);
  });

  it('stays quiet when a prior note still awaits a reaction (no stacking)', async () => {
    const h = makeService({
      unresolved: {
        id: 'o1',
        companionId: 'companion-1',
        noteMessageId: 'n1',
        proposalId: null,
        drive: 'curiosity',
        drivenByUserFactId: null,
        reward: null,
        createdAt: DAY_AGO,
        resolvedAt: null,
      },
    });
    expect((await h.service.prepare('companion-1', 'owner-1')).act).toBe(false);
  });
});

describe('GreetingService.markSeen', () => {
  it('stamps the arrival clock to now', async () => {
    const h = makeService();
    await h.service.markSeen('companion-1');
    expect(h.identity.markSeenCalls).toEqual([NOW]);
  });
});

describe('describeGap', () => {
  it('reads a sub-90-minute gap as "a little while"', () => {
    expect(describeGap(30 * 60_000)).toBe('a little while');
    expect(describeGap(45 * 60_000)).toBe('a little while');
  });

  it('reads roughly an hour as "about an hour"', () => {
    // ~89.7 min: rounds to 90 minutes (past the floor) but to 1 hour.
    expect(describeGap(5_382_000)).toBe('about an hour');
  });

  it('reads a several-hour gap in hours', () => {
    expect(describeGap(3 * 3_600_000)).toBe('about 3 hours');
    expect(describeGap(30 * 3_600_000)).toBe('about 30 hours');
  });

  it('reads a multi-day gap in days', () => {
    expect(describeGap(50 * 3_600_000)).toBe('about 2 days');
    expect(describeGap(5 * 86_400_000)).toBe('about 5 days');
  });
});

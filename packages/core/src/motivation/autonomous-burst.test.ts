/**
 * Autonomous burst (Phase 4.1) — reads the next `new` leads into memory billed to
 * ENERGY, then posts ONE report note. The focus here is the best-effort promise in
 * the docstring: one lead's failure must NOT abort the burst, must NOT leave that
 * lead `new` (re-read/re-billed next tick — a double-spend), and the note must
 * still post for the leads that did succeed. The ingestion pipeline is faked: it
 * bills the meter and flips the job done on success, and throws on demand.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { IngestionRunParams } from '../ingestion/pipeline.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleCompanionEnergyStore } from '../quota/energy-store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { runAutonomousBurst, type CompanionVoice } from './autonomous-burst.js';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const ENERGY_CAP = 10_000;
const TOKENS_PER_READ = 100;

/**
 * Fake pipeline: bill the meter + flip the job done, EXCEPT for URLs whose host
 * is in `failOn` — those throw after the meter would otherwise run (no spend, no
 * job update), simulating a network/parse blowup mid-burst.
 */
class FlakyReadPipeline implements IngestionTarget {
  constructor(
    private readonly semantic: DrizzleSemanticMemoryStore,
    private readonly failOn: ReadonlySet<string>,
  ) {}
  async run(params: IngestionRunParams): Promise<void> {
    if (this.failOn.has(params.sourceTitle)) {
      throw new Error(`boom reading ${params.sourceTitle}`);
    }
    if (params.meter) {
      await params.meter.quota.recordUsage(params.meter.accountId, TOKENS_PER_READ);
    }
    await this.semantic.updateJob(params.jobId, { status: 'done' });
  }
}

const VOICE: CompanionVoice = {
  name: 'Pip',
  form: 'fox',
  temperament: 'curious',
  evolvedPersona: null,
};

describe('runAutonomousBurst — best-effort per lead', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let leads: DrizzleLeadStore;
  let semantic: DrizzleSemanticMemoryStore;
  let memory: TranscriptMemoryStore;
  let energy: DrizzleCompanionEnergyStore;
  let rewards: DrizzleProactiveOutcomeStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    leads = new DrizzleLeadStore(db);
    semantic = new DrizzleSemanticMemoryStore(db);
    memory = new TranscriptMemoryStore(db);
    energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: ENERGY_CAP });
    rewards = new DrizzleProactiveOutcomeStore(db);
  });
  afterEach(async () => {
    await close();
  });

  function deps(
    pipeline: IngestionTarget,
    llm: FakeLlmGateway = new FakeLlmGateway(['Read ', 'what I could.']),
  ) {
    return {
      leads,
      semantic,
      pipeline,
      energy,
      memory,
      rewards,
      llm,
      model: 'fake-model',
      logger: silent,
    };
  }

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  it("one lead's failure does not abort the burst: good leads read, bad lead parked, note posts", async () => {
    await leads.record(companionId, 'https://a.dev');
    await leads.record(companionId, 'https://boom.dev'); // pipeline throws on this one
    await leads.record(companionId, 'https://c.dev');

    const llm = new FakeLlmGateway(['Read ', 'what I could.']);
    const result = await runAutonomousBurst(
      deps(new FlakyReadPipeline(semantic, new Set(['https://boom.dev'])), llm),
      {
        companionId,
        companion: VOICE,
        drive: 'curiosity',
        weights: DEFAULT_DRIVE_WEIGHTS,
        limit: 3,
      },
    );

    // The two healthy leads were read; the burst did not throw past the bad one.
    expect(result.read.map((r) => r.title).sort()).toEqual(['https://a.dev', 'https://c.dev']);
    expect(await leads.listByStatus(companionId, ['ingested'])).toHaveLength(2);

    // The failed lead is parked at `read` (attempted) — NOT left `new`, so the
    // next tick won't re-read and re-bill it (the double-spend the fix prevents).
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(0);
    const parked = await leads.listByStatus(companionId, ['read']);
    expect(parked.map((l) => l.url)).toEqual(['https://boom.dev']);

    // Energy was spent only on the two reads + the note — never on the failure.
    expect((await energy.getEnergy(companionId)).usedTokens).toBeGreaterThan(2 * TOKENS_PER_READ);

    // The user is still told what happened (never silent), exactly one note.
    expect(result.noteMessageId).not.toBeNull();
    const notes = await assistantNotes();
    expect(notes).toEqual(['Read what I could.']);

    // The report-note call is stamped with its prompt version (prompts/registry).
    expect(llm.lastParams?.promptRef?.id).toBe('autonomous-note');
    expect(llm.lastParams?.promptRef?.version.contentHash).toMatch(/^[0-9a-f]{16}$/);

    // One pending outcome linked to the note, awaiting the user's reaction.
    const outcomes = await rewards.list(companionId, 10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.noteMessageId).toBe(result.noteMessageId);
  });

  it('stops mid-burst when energy is exhausted, leaving later leads unread (still new)', async () => {
    await leads.record(companionId, 'https://first.dev');
    await leads.record(companionId, 'https://second.dev');
    await leads.record(companionId, 'https://third.dev');

    // A tiny pool: one read (TOKENS_PER_READ) lands at the cap, so the per-lead
    // exhaustion check breaks before the second lead is ever attempted.
    const tinyEnergy = new DrizzleCompanionEnergyStore(db, {
      defaultCapTokens: TOKENS_PER_READ,
    });
    const burstDeps = {
      ...deps(new FlakyReadPipeline(semantic, new Set())),
      energy: tinyEnergy,
    };

    const result = await runAutonomousBurst(burstDeps, {
      companionId,
      companion: VOICE,
      drive: 'curiosity',
      weights: DEFAULT_DRIVE_WEIGHTS,
      limit: 3,
    });

    // Only the first lead was read; the burst broke on exhaustion after it.
    expect(result.read.map((r) => r.title)).toEqual(['https://first.dev']);
    expect(await leads.listByStatus(companionId, ['ingested'])).toHaveLength(1);

    // The later leads were never attempted — still `new`, not parked at `read`.
    const stillNew = await leads.listByStatus(companionId, ['new']);
    expect(stillNew.map((l) => l.url).sort()).toEqual(['https://second.dev', 'https://third.dev']);
    expect(await leads.listByStatus(companionId, ['read'])).toHaveLength(0);

    // The note still posted for what it did manage to read.
    expect(result.noteMessageId).not.toBeNull();
    expect(await assistantNotes()).toEqual(['Read what I could.']);
    expect(await tinyEnergy.isExhausted(companionId)).toBe(true);
  });

  it('returns nothing for a non-positive limit: no reads, no spend, no note, leads untouched', async () => {
    // The arbitration layer can hand the burst limit 0 (no affordable/focus budget).
    // It must short-circuit before touching leads, energy, or the transcript.
    await leads.record(companionId, 'https://a.dev');

    const result = await runAutonomousBurst(deps(new FlakyReadPipeline(semantic, new Set())), {
      companionId,
      companion: VOICE,
      drive: 'curiosity',
      weights: DEFAULT_DRIVE_WEIGHTS,
      limit: 0,
    });

    expect(result.read).toHaveLength(0);
    expect(result.noteMessageId).toBeNull();
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
    // The lead is left exactly as it was — still `new`, nothing parked.
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);
    expect(await leads.listByStatus(companionId, ['read'])).toHaveLength(0);
    expect(await rewards.list(companionId, 10)).toHaveLength(0);
  });

  it('when every lead fails: no note, no spend, and all leads parked (no re-bill loop)', async () => {
    await leads.record(companionId, 'https://x.dev');
    await leads.record(companionId, 'https://y.dev');

    const result = await runAutonomousBurst(
      deps(new FlakyReadPipeline(semantic, new Set(['https://x.dev', 'https://y.dev']))),
      {
        companionId,
        companion: VOICE,
        drive: 'curiosity',
        weights: DEFAULT_DRIVE_WEIGHTS,
        limit: 2,
      },
    );

    expect(result.read).toHaveLength(0);
    expect(result.noteMessageId).toBeNull();
    expect(await assistantNotes()).toHaveLength(0);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);

    // Both parked at `read`, none left `new` — the next tick starts dry, not
    // re-reading the same failures forever.
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(0);
    expect(await leads.listByStatus(companionId, ['read'])).toHaveLength(2);
  });
});

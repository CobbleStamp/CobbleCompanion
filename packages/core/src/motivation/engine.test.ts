/**
 * Motivation engine tick (Phase 4.1) — idle is free; initiation READS the lead
 * inventory into memory (no approval), spends real energy, and posts one report
 * note; the gate (dial / energy / presence) suppresses initiation. The ingestion
 * pipeline is faked (a real read needs the network): the fake debits energy
 * through the per-run meter and marks the job done, so the engine's orchestration
 * — decide → read → note → outcome → energy — is what's under test.
 */

import { companions, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { IngestionRunParams } from '../ingestion/pipeline.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleVitalityStore, type VitalityStore } from '../quota/vitality-store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { MotivationEngine } from './engine.js';
import { InMemoryPresenceStore } from './presence-store.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
/** The wallet seed a new companion gets (matches the identity-store default). */
const ENERGY_START = 1_000_000;
const TOKENS_PER_READ = 100;

/** Build an energy wallet store over the test db. */
function energyStore(db: Database): DrizzleVitalityStore {
  return new DrizzleVitalityStore(db, 'energy');
}

/** Logger that captures `error` calls so a swallowed failure can be asserted. */
interface CapturingLogger extends Logger {
  readonly errors: { message: string; context: unknown }[];
}
function capturingLogger(): CapturingLogger {
  const errors: { message: string; context: unknown }[] = [];
  return {
    errors,
    error: (message: string, context?: unknown): void => {
      errors.push({ message, context });
    },
    warn: () => {},
    info: () => {},
  };
}

/** Fake pipeline: simulate a successful read — bill the meter, flip job done. */
class FakeReadPipeline implements IngestionTarget {
  constructor(private readonly semantic: DrizzleSemanticMemoryStore) {}
  async run(params: IngestionRunParams): Promise<void> {
    if (params.meter) {
      await params.meter.quota.spend(params.meter.accountId, TOKENS_PER_READ);
    }
    await this.semantic.updateJob(params.jobId, { status: 'done' });
  }
}

/** Fake pipeline that always throws — every autonomous read fails. */
class AlwaysThrowingPipeline implements IngestionTarget {
  async run(_params: IngestionRunParams): Promise<void> {
    throw new Error('read blew up');
  }
}

/** Logger capturing `info` entries so the structured tick log can be asserted. */
function infoCapturingLogger(): {
  logger: Logger;
  infos: { message: string; context: Record<string, unknown> }[];
} {
  const infos: { message: string; context: Record<string, unknown> }[] = [];
  return {
    infos,
    logger: {
      error: () => {},
      warn: () => {},
      info: (message: string, context?: unknown): void => {
        infos.push({ message, context: (context ?? {}) as Record<string, unknown> });
      },
    },
  };
}

describe('MotivationEngine.tick', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let identity: DrizzleIdentityStore;
  let leads: DrizzleLeadStore;
  let semantic: DrizzleSemanticMemoryStore;
  let memory: TranscriptMemoryStore;
  let energy: VitalityStore;
  let presence: InMemoryPresenceStore;
  let rewards: DrizzleProactiveOutcomeStore;
  let engine: MotivationEngine;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
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
    energy = energyStore(db);
    presence = new InMemoryPresenceStore();
    rewards = new DrizzleProactiveOutcomeStore(db);
    engine = new MotivationEngine({
      identity,
      presence,
      energy,
      leads,
      semantic,
      pipeline: new FakeReadPipeline(semantic),
      memory,
      rewards,
      llm: new FakeLlmGateway(['Read ', 'three things.']),
      model: 'fake-model',
      logger: silent,
    });
  });
  afterEach(async () => {
    await close();
  });

  async function seedLeads(n: number, offset = 0): Promise<void> {
    for (let i = offset; i < offset + n; i += 1) {
      await leads.record(companionId, `https://lead-${i}.dev`);
    }
  }

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  /** Energy spent so far = the drop from the seeded starting balance. */
  async function usedEnergy(): Promise<number> {
    return ENERGY_START - (await energy.getBalance(companionId));
  }

  it('stays idle (free) when there are no leads', async () => {
    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(result.move).toBeNull();
    expect(await usedEnergy()).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('reads the inventory autonomously, posts one note, spends real energy', async () => {
    await seedLeads(4);
    const result = await engine.tick(companionId);

    expect(result.initiated).toBe(true);
    expect(result.move?.kind).toBe('explore');
    // Default focus length 3 → three reads (the fourth lead is left for later).
    expect(result.sourcesRead).toBe(3);
    expect(await leads.listByStatus(companionId, ['ingested'])).toHaveLength(3);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);

    // Real energy spent: three reads + the report note (> reads alone).
    expect(result.energySpent).toBeGreaterThan(3 * TOKENS_PER_READ);
    expect(await usedEnergy()).toBe(result.energySpent);

    // Exactly one in-character report note was posted (not one per source).
    const notes = await assistantNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Read three things.');

    // One pending outcome, linked to the note, awaiting the user's reaction.
    const outcomes = await rewards.list(companionId, 10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.drive).toBe('curiosity');
    expect(outcomes[0]!.reward).toBeNull();
    expect(outcomes[0]!.noteMessageId).not.toBeNull();
  });

  it('does not stack a second initiation while a note awaits a reaction', async () => {
    // One reward-bearing note waits at a time (companion-motivation.md scenario
    // B). The per-turn affect delta attributes to a SINGLE pending outcome
    // (reinforce.ts); a second pending row would mis-credit the user's reaction.
    await seedLeads(4);
    const first = await engine.tick(companionId);
    expect(first.initiated).toBe(true);
    expect(await rewards.list(companionId, 10)).toHaveLength(1);

    // Plenty of fresh leads remain (a move WOULD be chosen) — so only the
    // unresolved outcome, not the drive gate, can keep this tick idle.
    await seedLeads(4, 10);
    const second = await engine.tick(companionId);
    expect(second.initiated).toBe(false);
    expect(second.move).toBeNull();
    expect(await assistantNotes()).toHaveLength(1); // still the one note
    expect(await rewards.list(companionId, 10)).toHaveLength(1); // no second outcome

    // Once the user reacts (outcome resolved), the engine is free again.
    const [pending] = await rewards.list(companionId, 1);
    await rewards.setReward(companionId, pending!.id, 1);
    const third = await engine.tick(companionId);
    expect(third.initiated).toBe(true);
    expect(await rewards.list(companionId, 10)).toHaveLength(2);
  });

  it('stays idle when the dial is off', async () => {
    await seedLeads(4);
    await db
      .update(companions)
      .set({ proactivityDial: 'off' })
      .where(eq(companions.id, companionId));

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await usedEnergy()).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('stops initiating when energy is exhausted (chat would still run on stamina)', async () => {
    await seedLeads(4);
    await energy.spend(companionId, ENERGY_START); // drain the wallet
    expect(await energy.isEmpty(companionId)).toBe(true);

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    // The wallet is empty; nothing further read or posted.
    expect(await energy.isEmpty(companionId)).toBe(true);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(4);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('does not self-initiate while the user is actively engaged', async () => {
    await seedLeads(4);
    presence.recordActivity(companionId); // user just acted → active

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('logs and swallows a failed tick → returns idle, never throws', async () => {
    await seedLeads(4);
    const logger = capturingLogger();
    // A sensing dependency throws partway through the tick.
    const failingLeads = {
      ...leads,
      listByStatus: async (): Promise<never> => {
        throw new Error('lead store down');
      },
    } as unknown as DrizzleLeadStore;
    const failing = new MotivationEngine({
      identity,
      presence,
      energy,
      leads: failingLeads,
      semantic,
      pipeline: new FakeReadPipeline(semantic),
      memory,
      rewards,
      llm: new FakeLlmGateway(['Read ', 'three things.']),
      model: 'fake-model',
      logger,
    });

    const result = await failing.tick(companionId);

    // The failure was swallowed into the idle result — not rethrown.
    expect(result).toEqual({
      initiated: false,
      move: null,
      sourcesRead: 0,
      energySpent: 0,
    });
    // And it was logged at error severity (no silent failure).
    expect(logger.errors.map((e) => e.message)).toContain('motivation tick failed');
    // Nothing was spent or posted.
    expect(await usedEnergy()).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('reports initiated:false with a non-null move when the burst reads nothing', async () => {
    await seedLeads(3);
    // The engine decides to act (leads present → a move), but every read fails,
    // so the burst remembers nothing and posts no note.
    const acted = new MotivationEngine({
      identity,
      presence,
      energy,
      leads,
      semantic,
      pipeline: new AlwaysThrowingPipeline(),
      memory,
      rewards,
      llm: new FakeLlmGateway(['Read ', 'three things.']),
      model: 'fake-model',
      logger: silent,
    });

    const result = await acted.tick(companionId);

    // It DID decide to act — the move is non-null — but nothing was read.
    expect(result.move).not.toBeNull();
    expect(result.move?.kind).toBe('explore');
    expect(result.sourcesRead).toBe(0);
    expect(result.initiated).toBe(false);

    // No note posted; failed reads parked at `read` (not left `new`, no re-bill).
    expect(await assistantNotes()).toHaveLength(0);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(0);
    expect(await rewards.list(companionId, 10)).toHaveLength(0);
  });

  it('logs the real wallet drop as the spend metric (reads + note)', async () => {
    await seedLeads(3);
    // Energy spent = the drop in the wallet balance across the burst (before −
    // after). The structured tick log surfaces that same figure.
    const { logger, infos } = infoCapturingLogger();
    const logging = new MotivationEngine({
      identity,
      presence,
      energy,
      leads,
      semantic,
      pipeline: new FakeReadPipeline(semantic),
      memory,
      rewards,
      llm: new FakeLlmGateway(['Read ', 'three things.']),
      model: 'fake-model',
      logger,
    });

    const result = await logging.tick(companionId);

    expect(result.initiated).toBe(true);
    expect(result.sourcesRead).toBe(3);
    // The wallet drop equals the reported spend; both exceed the bare reads (note).
    expect(result.energySpent).toBeGreaterThan(3 * TOKENS_PER_READ);
    expect(await usedEnergy()).toBe(result.energySpent);
    const initiated = infos.find((e) => e.message === 'motivation tick initiated');
    expect(initiated?.context.energySpent).toBe(result.energySpent);
  });
});

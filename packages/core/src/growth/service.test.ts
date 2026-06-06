/**
 * Growth service — derives the four axes from real substrate, advances the mark
 * idempotently, awards treats, and posts growth notes. Exercised over the
 * in-memory DB with the real stores (fakes-over-mocks: a real PGlite, not stubs).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { growthReflectionNote } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEpisodicMemoryStore } from '../memory/episodic-store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleCompanionAffectStore } from '../motivation/affect-store.js';
import { DrizzleProactiveOutcomeStore } from '../motivation/reward-store.js';
import { DrizzleProceduralStore } from '../tools/procedural-store.js';
import { DrizzleToolCallLog } from '../tools/tool-call-log.js';
import { DEFAULT_GROWTH_CONFIG } from './config.js';
import { DrizzleGrowthStore } from './growth-store.js';
import { GrowthService } from './service.js';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

describe('GrowthService', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let service: GrowthService;
  let identity: DrizzleIdentityStore;
  let semantic: DrizzleSemanticMemoryStore;
  let episodic: DrizzleEpisodicMemoryStore;
  let procedural: DrizzleProceduralStore;
  let toolCallLog: DrizzleToolCallLog;
  let rewards: DrizzleProactiveOutcomeStore;
  let affect: DrizzleCompanionAffectStore;
  let memory: TranscriptMemoryStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    semantic = new DrizzleSemanticMemoryStore(db);
    episodic = new DrizzleEpisodicMemoryStore(db);
    procedural = new DrizzleProceduralStore(db);
    toolCallLog = new DrizzleToolCallLog(db);
    rewards = new DrizzleProactiveOutcomeStore(db);
    affect = new DrizzleCompanionAffectStore(db);
    memory = new TranscriptMemoryStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    service = new GrowthService({
      identity,
      semantic,
      episodic,
      procedural,
      toolCallLog,
      rewards,
      affect,
      growth: new DrizzleGrowthStore(db, { initialTreats: DEFAULT_GROWTH_CONFIG.initialTreats }),
      memory,
      logger: silentLogger,
    });
  });
  afterEach(async () => {
    await close();
  });

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  it('reports a fresh, unformed companion in the empty bands', async () => {
    const dto = await service.snapshot(companionId);
    expect(dto.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats);
    expect(dto.knowledge.band).toBe('Sparse');
    expect(dto.bond.band).toBe('New');
    expect(dto.initiative.band).toBe("Hasn't ventured out yet");
    expect(dto.character.band).toBe('Still forming');
    expect(dto.capabilities.every((c) => !c.observed)).toBe(true);
  });

  it('derives axes/capabilities from substrate, awards treats, and posts reflections', async () => {
    // Knowledge: 4 sources × 3 points = 12 ≥ 10 → band 1 (Growing), observes reading_sources.
    for (let i = 0; i < 4; i += 1) {
      await semantic.createSource(companionId, {
        kind: 'note',
        title: `note ${i}`,
        rawText: 'hello world',
      });
    }
    // Capabilities from the tool/procedure/affect logs.
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');
    await toolCallLog.record(companionId, 'memory_search', {}, 'ok');
    await procedural.record(companionId, 'book a hotel', ['web_fetch', 'ingest_source']);
    await affect.upsert(companionId, { valence: 0.4, note: 'pleased' });

    const transition = await service.recompute(companionId);
    expect(transition.knowledgeAdvanced).toBe(true);
    expect(transition.newCapabilities).toContain('reading_sources');
    expect(transition.newCapabilities).toContain('web_research');
    expect(transition.treatsEarned).toBeGreaterThan(0);

    const dto = await service.snapshot(companionId);
    expect(dto.knowledge.band).toBe('Growing');
    expect(dto.capabilities.find((c) => c.key === 'web_research')?.observed).toBe(true);
    expect(dto.capabilities.find((c) => c.key === 'first_routine')?.observed).toBe(true);
    expect(dto.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats + transition.treatsEarned);

    const notes = await assistantNotes();
    expect(notes).toContain(growthReflectionNote('knowledge'));
  });

  it('is idempotent — a second recompute neither re-awards treats nor re-posts reflections', async () => {
    await semantic.createSource(companionId, { kind: 'note', title: 'n', rawText: 'hi' });
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');

    const first = await service.recompute(companionId);
    expect(first.newCapabilities.length).toBeGreaterThan(0);
    const treatsAfterFirst = (await service.snapshot(companionId)).treats;
    const notesAfterFirst = (await assistantNotes()).length;

    const second = await service.recompute(companionId);
    expect(second.newCapabilities).toEqual([]);
    expect(second.treatsEarned).toBe(0);
    expect((await service.snapshot(companionId)).treats).toBe(treatsAfterFirst);
    expect((await assistantNotes()).length).toBe(notesAfterFirst);
  });

  it('reflects an Initiative reading from the proactive-outcome log', async () => {
    await rewards.record(companionId, { drive: 'curiosity' });
    const transition = await service.recompute(companionId);
    expect(transition.initiativeAdvanced).toBe(true);
    const dto = await service.snapshot(companionId);
    expect(dto.initiative.band).toBe('Tentative');
    expect(dto.initiative.detail).toContain('1 self-directed');
  });

  it('surfaces the emerged character once weights diverge from neutral', async () => {
    await identity.updateDriveWeights(companionId, {
      curiosity: 0.9,
      bond: 0.8,
      understanding: 0.5,
      approval: 0.5,
      helpfulness: 0.5,
      upkeep: 0.5,
    });
    const dto = await service.snapshot(companionId);
    expect(dto.character.drives.find((d) => d.key === 'curiosity')?.weight).toBeCloseTo(0.9);
    expect(dto.character.drives).toHaveLength(6);
  });
});

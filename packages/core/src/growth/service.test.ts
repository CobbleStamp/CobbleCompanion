/**
 * Growth service — derives the four axes from real substrate, advances the mark
 * idempotently, and posts growth notes. Exercised over the in-memory DB with the
 * real stores (fakes-over-mocks: a real PGlite, not stubs).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { growthReflectionNote } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEpisodicMemoryStore } from '../memory/episodic-store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleCompanionAffectStore } from '../motivation/affect-store.js';
import { DrizzleProactiveOutcomeStore } from '../motivation/reward-store.js';
import { DrizzleProceduralStore } from '../tools/procedural-store.js';
import { DrizzleToolCallLog } from '../tools/tool-call-log.js';
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
  let growthStore: DrizzleGrowthStore;

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
    growthStore = new DrizzleGrowthStore(db);
    service = new GrowthService({
      identity,
      semantic,
      episodic,
      procedural,
      toolCallLog,
      rewards,
      affect,
      growth: growthStore,
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
    expect(dto.knowledge.band).toBe('Sparse');
    expect(dto.bond.band).toBe('New');
    expect(dto.initiative.band).toBe("Hasn't ventured out yet");
    expect(dto.character.band).toBe('Still forming');
    expect(dto.capabilities.every((c) => !c.observed)).toBe(true);
  });

  it('derives axes/capabilities from substrate and posts reflections', async () => {
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

    const dto = await service.snapshot(companionId);
    expect(dto.knowledge.band).toBe('Growing');
    expect(dto.capabilities.find((c) => c.key === 'web_research')?.observed).toBe(true);
    expect(dto.capabilities.find((c) => c.key === 'first_routine')?.observed).toBe(true);

    const notes = await assistantNotes();
    expect(notes).toContain(growthReflectionNote('knowledge'));

    // The transition carries the persisted reflections so the caller can stream
    // them in place; they match what landed in the transcript.
    expect(transition.reflections.length).toBeGreaterThan(0);
    const reflectionContents = transition.reflections.map((m) => m.content);
    expect(reflectionContents).toContain(growthReflectionNote('knowledge'));
    expect(reflectionContents.every((c) => notes.includes(c))).toBe(true);
  });

  it('is idempotent — a second recompute re-posts no reflections', async () => {
    await semantic.createSource(companionId, { kind: 'note', title: 'n', rawText: 'hi' });
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');

    const first = await service.recompute(companionId);
    expect(first.newCapabilities.length).toBeGreaterThan(0);
    const notesAfterFirst = (await assistantNotes()).length;

    const second = await service.recompute(companionId);
    expect(second.newCapabilities).toEqual([]);
    expect(second.reflections).toEqual([]);
    expect((await assistantNotes()).length).toBe(notesAfterFirst);
  });

  it('shows a dip on the surface, holds the mark, and never re-fires on recover', async () => {
    // Climb knowledge to Broad: 7 sources × 3 points = 21 ≥ 20 → band 2.
    const sourceIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const source = await semantic.createSource(companionId, {
        kind: 'note',
        title: `note ${i}`,
        rawText: 'hello world',
      });
      sourceIds.push(source.id);
    }
    const climb = await service.recompute(companionId);
    expect(climb.knowledgeAdvanced).toBe(true);
    expect((await service.snapshot(companionId)).knowledge.band).toBe('Broad');

    const markAfterClimb = await growthStore.getSnapshot(companionId);
    expect(markAfterClimb.knowledgeBand).toBe(2);
    const knowledgeNotesAfterClimb = (await assistantNotes()).filter(
      (n) => n === growthReflectionNote('knowledge'),
    ).length;
    expect(knowledgeNotesAfterClimb).toBe(1);

    // Dip: delete 3 sources → 4 × 3 = 12 points → band 1 (Growing), below the mark.
    for (const id of sourceIds.slice(0, 3)) {
      expect(await semantic.deleteSource(companionId, id)).toBe(true);
    }

    // (a) The surface shows the LOWER live reading — the mark never floors what's shown.
    const dipped = await service.snapshot(companionId);
    expect(dipped.knowledge.band).toBe('Growing');

    // (b) The stored mark is unchanged by the dip (it only ever climbs).
    const markAfterDip = await growthStore.getSnapshot(companionId);
    expect(markAfterDip.knowledgeBand).toBe(2);

    // Recover back up to Broad (band 2), an already-reflected band.
    for (let i = 0; i < 3; i += 1) {
      await semantic.createSource(companionId, {
        kind: 'note',
        title: `note recover ${i}`,
        rawText: 'hello world',
      });
    }
    const recover = await service.recompute(companionId);

    // (c) Re-climbing to an already-reflected band re-posts no reflection — the
    //     mark gates the once-only side effect.
    expect(recover.knowledgeAdvanced).toBe(false);
    const recovered = await service.snapshot(companionId);
    expect(recovered.knowledge.band).toBe('Broad');
    const knowledgeNotesAfterRecover = (await assistantNotes()).filter(
      (n) => n === growthReflectionNote('knowledge'),
    ).length;
    expect(knowledgeNotesAfterRecover).toBe(1);
  });

  it('reads the stored mark once on recompute and never on snapshot', async () => {
    // Substrate that genuinely advances the mark, so recompute runs its full path
    // (read → compare → advance), not just the early no-progress return.
    await semantic.createSource(companionId, { kind: 'note', title: 'n', rawText: 'hi' });
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');

    // The service holds a reference to this same store instance; advance() does NOT
    // call getSnapshot internally, so the spy counts only the service's own reads.
    const getSnapshot = vi.spyOn(growthStore, 'getSnapshot');

    const transition = await service.recompute(companionId);
    expect(transition.newCapabilities.length).toBeGreaterThan(0); // the advance path actually ran
    // The crux: one read for the CAS `from`.
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // The view is fully derived from substrate; the stored mark gates only the
    // once-only reflections (a recompute concern), so a pure snapshot never reads it.
    getSnapshot.mockClear();
    await service.snapshot(companionId);
    expect(getSnapshot).toHaveBeenCalledTimes(0);

    getSnapshot.mockRestore();
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

/** Proactive-outcome store — record (note-linked), latest-unresolved, set-reward, list. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleUserModelStore } from '../user-model/store.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';

describe('DrizzleProactiveOutcomeStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let userId: string;
  let rewards: DrizzleProactiveOutcomeStore;
  let memory: TranscriptMemoryStore;
  let userModel: DrizzleUserModelStore;
  let semantic: DrizzleSemanticMemoryStore;

  /** Append an assistant "report" note and return its id (the reward target). */
  async function noteId(content = 'I read a couple of things from my list.'): Promise<string> {
    const row = await memory.appendMessage(companionId, 'assistant', content);
    return row.id;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    rewards = new DrizzleProactiveOutcomeStore(db);
    memory = new TranscriptMemoryStore(db);
    userModel = new DrizzleUserModelStore(db);
    semantic = new DrizzleSemanticMemoryStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('records a note-linked outcome and resolves its reward', async () => {
    const noteMessageId = await noteId();
    const outcome = await rewards.record(companionId, {
      noteMessageId,
      drive: 'curiosity',
      driveSnapshot: DEFAULT_DRIVE_WEIGHTS,
    });
    expect(outcome.reward).toBeNull();
    expect(outcome.drive).toBe('curiosity');
    expect(outcome.noteMessageId).toBe(noteMessageId);

    await rewards.setReward(companionId, outcome.id, 1);
    const resolved = await rewards.findLatestUnresolved(companionId);
    expect(resolved).toBeNull(); // it's resolved now — no longer pending
    const [listed] = await rewards.list(companionId, 1);
    expect(listed?.reward).toBe(1);
    expect(listed?.resolvedAt).not.toBeNull();
  });

  it('claims an outcome atomically — only the first setReward wins', async () => {
    const outcome = await rewards.record(companionId, {
      noteMessageId: await noteId(),
      drive: 'curiosity',
    });
    // First reaction claims it; a racing second sees reward already set and bails.
    expect(await rewards.setReward(companionId, outcome.id, 0.7)).toBe(true);
    expect(await rewards.setReward(companionId, outcome.id, -0.9)).toBe(false);
    // The losing call must not overwrite the winner's reward.
    const [listed] = await rewards.list(companionId, 1);
    expect(listed?.reward).toBeCloseTo(0.7);
  });

  it('finds the most recent unresolved outcome (reward attribution target)', async () => {
    await rewards.record(companionId, { noteMessageId: await noteId('first'), drive: 'curiosity' });
    const second = await rewards.record(companionId, {
      noteMessageId: await noteId('second'),
      drive: 'bond',
    });
    const latest = await rewards.findLatestUnresolved(companionId);
    expect(latest?.id).toBe(second.id);
    expect(latest?.drive).toBe('bond');
  });

  it('skips already-resolved outcomes when finding the latest unresolved', async () => {
    const resolved = await rewards.record(companionId, {
      noteMessageId: await noteId(),
      drive: 'curiosity',
    });
    await rewards.setReward(companionId, resolved.id, -1);
    expect(await rewards.findLatestUnresolved(companionId)).toBeNull();
  });

  it('does not set the reward for another companion (tenancy invariant)', async () => {
    const outcome = await rewards.record(companionId, {
      noteMessageId: await noteId(),
      drive: 'curiosity',
    });
    await rewards.setReward('00000000-0000-0000-0000-000000000000', outcome.id, 1);
    const found = await rewards.findLatestUnresolved(companionId);
    expect(found?.id).toBe(outcome.id);
    expect(found?.reward).toBeNull();
  });

  it('finds the unresolved outcome by its note message id (the addressed path)', async () => {
    const noteMessageId = await noteId();
    const outcome = await rewards.record(companionId, { noteMessageId, drive: 'curiosity' });
    const found = await rewards.findUnresolvedByNoteMessageId(companionId, noteMessageId);
    expect(found?.id).toBe(outcome.id);
    // An unrelated message id, and a foreign companion, both find nothing.
    expect(await rewards.findUnresolvedByNoteMessageId(companionId, await noteId())).toBeNull();
    expect(
      await rewards.findUnresolvedByNoteMessageId(
        '00000000-0000-0000-0000-000000000000',
        noteMessageId,
      ),
    ).toBeNull();
  });

  it('does not return a note-addressed outcome once it is resolved', async () => {
    const noteMessageId = await noteId();
    const outcome = await rewards.record(companionId, { noteMessageId, drive: 'curiosity' });
    await rewards.setReward(companionId, outcome.id, 0.5);
    expect(await rewards.findUnresolvedByNoteMessageId(companionId, noteMessageId)).toBeNull();
  });

  it("a real companion cannot claim or read another's pending outcome (tenancy isolation)", async () => {
    // The zero-UUID case above only proves "an id owning no rows matches nothing".
    // This proves the actual invariant the companion-scope fix protects: with TWO
    // real companions each holding a pending outcome, A's reaction can neither
    // claim nor surface B's outcome, and vice versa.
    const identity = new DrizzleIdentityStore(db);
    const owner = await identity.ensureUserByEmail('owner@example.com');
    const other = await identity.createCompanion(owner.id, {
      name: 'Moss',
      form: 'cat',
      temperament: 'calm',
    });
    const otherNote = await memory.appendMessage(other.id, 'assistant', 'Moss read something.');

    const mine = await rewards.record(companionId, {
      noteMessageId: await noteId(),
      drive: 'curiosity',
    });
    const theirs = await rewards.record(other.id, {
      noteMessageId: otherNote.id,
      drive: 'bond',
    });

    // A's reaction must not claim B's pending outcome…
    expect(await rewards.setReward(companionId, theirs.id, 1)).toBe(false);
    // …and each companion only ever sees its own pending outcome.
    expect((await rewards.findLatestUnresolved(companionId))?.id).toBe(mine.id);
    expect((await rewards.findLatestUnresolved(other.id))?.id).toBe(theirs.id);
    // B's own reaction still claims it, leaving A's untouched.
    expect(await rewards.setReward(other.id, theirs.id, 1)).toBe(true);
    expect((await rewards.findLatestUnresolved(companionId))?.reward).toBeNull();
  });

  it('claims atomically under a true concurrent race — exactly one winner', async () => {
    // The sequential test above proves "the second call sees reward already set".
    // This races the two reactions with Promise.all: exactly one setReward must
    // win and the stored reward must be one contender's value, never summed or
    // clobbered.
    const outcome = await rewards.record(companionId, {
      noteMessageId: await noteId(),
      drive: 'curiosity',
    });
    const results = await Promise.all([
      rewards.setReward(companionId, outcome.id, 0.7),
      rewards.setReward(companionId, outcome.id, -0.9),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    const [listed] = await rewards.list(companionId, 1);
    const reward = listed!.reward!;
    const isContender = Math.abs(reward - 0.7) < 1e-6 || Math.abs(reward + 0.9) < 1e-6;
    expect(isContender).toBe(true);
  });

  it('lists outcomes newest-first', async () => {
    await rewards.record(companionId, { noteMessageId: await noteId('a'), drive: 'curiosity' });
    await rewards.record(companionId, { noteMessageId: await noteId('b'), drive: 'bond' });
    const list = await rewards.list(companionId, 10);
    expect(list).toHaveLength(2);
    expect(list[0]!.drive).toBe('bond'); // newest first
  });

  describe('listDetailed', () => {
    it('joins the report note, weight snapshot, and driving belief', async () => {
      const belief = await userModel.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'Rust',
      });
      const noteMessageId = await noteId('I read about Rust ownership.');
      await rewards.record(companionId, {
        noteMessageId,
        drive: 'curiosity',
        driveSnapshot: DEFAULT_DRIVE_WEIGHTS,
        drivenByUserFactId: belief.id,
      });

      const [detail] = await rewards.listDetailed(companionId, 10);
      expect(detail?.noteContent).toBe('I read about Rust ownership.');
      expect(detail?.drive).toBe('curiosity');
      expect(detail?.driveSnapshot).toEqual(DEFAULT_DRIVE_WEIGHTS);
      expect(detail?.belief?.object).toBe('Rust');
      expect(detail?.seq).toBeGreaterThan(0);
    });

    it('lists a non-belief-driven outcome with null belief (LEFT JOIN)', async () => {
      await rewards.record(companionId, { noteMessageId: await noteId('plain'), drive: 'bond' });
      const [detail] = await rewards.listDetailed(companionId, 10);
      expect(detail?.noteContent).toBe('plain');
      expect(detail?.belief).toBeNull();
    });

    it('paginates by seq with the beforeSeq cursor', async () => {
      await rewards.record(companionId, { noteMessageId: await noteId('1'), drive: 'curiosity' });
      await rewards.record(companionId, { noteMessageId: await noteId('2'), drive: 'bond' });
      await rewards.record(companionId, {
        noteMessageId: await noteId('3'),
        drive: 'understanding',
      });

      const firstPage = await rewards.listDetailed(companionId, 2);
      expect(firstPage.map((o) => o.noteContent)).toEqual(['3', '2']); // newest first
      const nextPage = await rewards.listDetailed(companionId, 2, firstPage[1]!.seq);
      expect(nextPage).toHaveLength(1);
      expect(nextPage[0]!.noteContent).toBe('1');
    });

    it('attaches read sources enriched with their findings (section topics)', async () => {
      const src = await semantic.createSource(companionId, {
        kind: 'link',
        title: 'https://ex.com/cpi',
        origin: 'https://ex.com/cpi',
        rawText: 'x',
      });
      await semantic.insertSections(companionId, src.id, [
        { topicTitle: 'Risk Disclaimer', originalText: '…', paraStart: 0, paraEnd: 1, ord: 0 },
        { topicTitle: 'Copyright Notice', originalText: '…', paraStart: 1, paraEnd: 2, ord: 1 },
      ]);
      await rewards.record(companionId, {
        noteMessageId: await noteId('I read it'),
        drive: 'curiosity',
        readSources: [{ sourceId: src.id, title: 'https://ex.com/cpi' }],
      });

      const [detail] = await rewards.listDetailed(companionId, 10);
      expect(detail?.sources).toHaveLength(1);
      expect(detail?.sources[0]?.sourceId).toBe(src.id);
      expect(detail?.sources[0]?.title).toBe('https://ex.com/cpi');
      expect(detail?.sources[0]?.findings).toEqual(['Risk Disclaimer', 'Copyright Notice']);
    });

    it('lists a read source with empty findings when it yielded no sections', async () => {
      const src = await semantic.createSource(companionId, {
        kind: 'link',
        title: 'https://ex.com/empty',
        origin: 'https://ex.com/empty',
        rawText: '',
      });
      await rewards.record(companionId, {
        noteMessageId: await noteId('only boilerplate'),
        drive: 'curiosity',
        readSources: [{ sourceId: src.id, title: 'https://ex.com/empty' }],
      });

      const [detail] = await rewards.listDetailed(companionId, 10);
      expect(detail?.sources).toHaveLength(1);
      expect(detail?.sources[0]?.findings).toEqual([]);
    });

    it('defaults sources to an empty array for a non-reading act (legacy row)', async () => {
      await rewards.record(companionId, { noteMessageId: await noteId('plain'), drive: 'bond' });
      const [detail] = await rewards.listDetailed(companionId, 10);
      expect(detail?.sources).toEqual([]);
    });

    it('scopes to the companion (tenancy)', async () => {
      const identity = new DrizzleIdentityStore(db);
      const other = await identity.createCompanion(userId, {
        name: 'Moss',
        form: 'cat',
        temperament: 'calm',
      });
      const otherNote = await memory.appendMessage(other.id, 'assistant', 'Moss read something.');
      await rewards.record(other.id, { noteMessageId: otherNote.id, drive: 'bond' });
      await rewards.record(companionId, {
        noteMessageId: await noteId('mine'),
        drive: 'curiosity',
      });

      const mine = await rewards.listDetailed(companionId, 10);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.noteContent).toBe('mine');
    });
  });
});

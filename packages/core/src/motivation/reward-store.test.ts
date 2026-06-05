/** Proactive-outcome store — record (note-linked), latest-unresolved, set-reward, list. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';

describe('DrizzleProactiveOutcomeStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let rewards: DrizzleProactiveOutcomeStore;
  let memory: TranscriptMemoryStore;

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
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    rewards = new DrizzleProactiveOutcomeStore(db);
    memory = new TranscriptMemoryStore(db);
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

  it('lists outcomes newest-first', async () => {
    await rewards.record(companionId, { noteMessageId: await noteId('a'), drive: 'curiosity' });
    await rewards.record(companionId, { noteMessageId: await noteId('b'), drive: 'bond' });
    const list = await rewards.list(companionId, 10);
    expect(list).toHaveLength(2);
    expect(list[0]!.drive).toBe('bond'); // newest first
  });
});

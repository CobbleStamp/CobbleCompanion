import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from './store.js';

describe('TranscriptMemoryStore', () => {
  let memory: TranscriptMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;
  let otherCompanionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    memory = new TranscriptMemoryStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    const other = await identity.createCompanion(user.id, {
      name: 'Cobble',
      form: 'dog',
      temperament: 'playful',
    });
    otherCompanionId = other.id;
  });

  afterEach(async () => {
    await close();
  });

  it('appends messages and recalls them oldest-first within the limit', async () => {
    await memory.appendMessage(companionId, 'user', 'one');
    await memory.appendMessage(companionId, 'assistant', 'two');
    await memory.appendMessage(companionId, 'user', 'three');

    const recent = await memory.getRecentMessages(companionId, 2);
    // Two most recent, returned oldest-first.
    expect(recent.map((m) => m.content)).toEqual(['two', 'three']);
    expect(recent.every((m) => m.companionId === companionId)).toBe(true);
  });

  it('scopes the transcript to its own companion', async () => {
    await memory.appendMessage(companionId, 'user', 'mine');
    await memory.appendMessage(otherCompanionId, 'user', 'theirs');

    const recent = await memory.getRecentMessages(companionId, 10);
    expect(recent.map((m) => m.content)).toEqual(['mine']);
  });

  it('counts the messages in a companion transcript', async () => {
    expect(await memory.countMessages(companionId)).toBe(0);
    await memory.appendMessage(companionId, 'user', 'one');
    await memory.appendMessage(companionId, 'assistant', 'two');
    expect(await memory.countMessages(companionId)).toBe(2);
  });
});

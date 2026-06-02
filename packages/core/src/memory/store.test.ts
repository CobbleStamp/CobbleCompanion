import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from './store.js';

describe('TranscriptMemoryStore', () => {
  let memory: TranscriptMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;

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
  });

  afterEach(async () => {
    await close();
  });

  it('creates a conversation and reads it back', async () => {
    const conversation = await memory.createConversation(companionId);
    expect(await memory.getConversation(conversation.id)).toEqual(conversation);
  });

  it('appends messages and recalls them oldest-first within the limit', async () => {
    const conversation = await memory.createConversation(companionId);
    await memory.appendMessage(conversation.id, 'user', 'one');
    await memory.appendMessage(conversation.id, 'assistant', 'two');
    await memory.appendMessage(conversation.id, 'user', 'three');

    const recent = await memory.getRecentMessages(conversation.id, 2);
    // Two most recent, returned oldest-first.
    expect(recent.map((m) => m.content)).toEqual(['two', 'three']);
  });

  it('returns null for a missing conversation', async () => {
    expect(await memory.getConversation('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists only the given companion conversations', async () => {
    const first = await memory.createConversation(companionId);
    const second = await memory.createConversation(companionId);

    const listed = await memory.listConversations(companionId);
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
  });

  it('counts the messages in a conversation', async () => {
    const conversation = await memory.createConversation(companionId);
    expect(await memory.countMessages(conversation.id)).toBe(0);
    await memory.appendMessage(conversation.id, 'user', 'one');
    await memory.appendMessage(conversation.id, 'assistant', 'two');
    expect(await memory.countMessages(conversation.id)).toBe(2);
  });
});

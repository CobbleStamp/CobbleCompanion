import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleSemanticMemoryStore } from './semantic-store.js';
import { TranscriptMemoryStore } from './store.js';

describe('TranscriptMemoryStore', () => {
  let memory: TranscriptMemoryStore;
  let semantic: DrizzleSemanticMemoryStore;
  let close: () => Promise<void>;
  let companionId: string;
  let otherCompanionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    memory = new TranscriptMemoryStore(created.db);
    semantic = new DrizzleSemanticMemoryStore(created.db);
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

  it('defaults sourceId to null for an ordinary turn', async () => {
    const message = await memory.appendMessage(companionId, 'user', 'just typing');
    expect(message.sourceId).toBeNull();
    const [recalled] = await memory.getRecentMessages(companionId, 1);
    expect(recalled?.sourceId).toBeNull();
  });

  it('round-trips a row kind and metadata (the rich-conversation columns)', async () => {
    const citation = {
      sourceId: 's1',
      sourceTitle: 'Peru book',
      chapterTitle: '4',
      topicTitle: 'Sacred Valley',
      paraStart: 1,
      paraEnd: 3,
      pageStart: null,
      pageEnd: null,
    };
    await memory.appendMessage(companionId, 'assistant', 'Read example.com', {
      kind: 'tool_step',
      metadata: { toolName: 'web_fetch' },
    });
    const grounded = await memory.appendMessage(companionId, 'assistant', 'Grounded reply', {
      metadata: { citations: [citation] },
    });
    expect(grounded.kind).toBe('message');
    expect(grounded.metadata?.citations).toEqual([citation]);

    const recent = await memory.getRecentMessages(companionId, 10);
    const step = recent.find((m) => m.kind === 'tool_step');
    expect(step?.metadata?.toolName).toBe('web_fetch');
  });

  it('excludes tool_step / proposal rows from the consolidation window', async () => {
    await memory.appendMessage(companionId, 'user', 'real turn');
    await memory.appendMessage(companionId, 'assistant', 'Read example.com', {
      kind: 'tool_step',
      metadata: { toolName: 'web_fetch' },
    });
    await memory.appendMessage(companionId, 'assistant', 'held action', {
      kind: 'proposal',
      metadata: { proposalId: 'p1', toolName: 'ingest_source' },
    });
    await memory.appendMessage(companionId, 'assistant', 'real reply');

    // Consolidation reflects over the conversation only — UI chrome never
    // becomes episodic memory.
    const window = await memory.getMessagesSince(companionId, 0, 10);
    expect(window.map((m) => m.content)).toEqual(['real turn', 'real reply']);
  });

  it('reads transcript turns after a seq cursor, oldest-first, with seq + Date', async () => {
    const first = await memory.appendMessage(companionId, 'user', 'one');
    await memory.appendMessage(companionId, 'assistant', 'two');
    await memory.appendMessage(companionId, 'user', 'three');

    // The whole window starts from the very beginning (cursor 0).
    const all = await memory.getMessagesSince(companionId, 0, 10);
    expect(all.map((m) => m.content)).toEqual(['one', 'two', 'three']);
    expect(all[0]?.seq).toBeTypeOf('number');
    expect(all[0]?.createdAt).toBeInstanceOf(Date);

    // Only turns strictly after the first message's seq.
    const since = await memory.getMessagesSince(companionId, all[0]!.seq, 10);
    expect(since.map((m) => m.content)).toEqual(['two', 'three']);

    // The limit caps the window from the cursor forward.
    const capped = await memory.getMessagesSince(companionId, 0, 2);
    expect(capped.map((m) => m.content)).toEqual(['one', 'two']);

    // Scoped to its own companion.
    await memory.appendMessage(otherCompanionId, 'user', 'theirs');
    const mineOnly = await memory.getMessagesSince(companionId, 0, 10);
    expect(mineOnly.every((m) => m.content !== 'theirs')).toBe(true);
    expect(first.id).toBeTypeOf('string');
  });

  it('links a turn to its source and round-trips the sourceId', async () => {
    const source = await semantic.createSource(companionId, {
      kind: 'pdf',
      title: 'report',
      rawText: '',
    });
    const message = await memory.appendMessage(companionId, 'user', 'report.pdf', {
      sourceId: source.id,
    });
    expect(message.sourceId).toBe(source.id);
    const [recalled] = await memory.getRecentMessages(companionId, 1);
    expect(recalled?.sourceId).toBe(source.id);
  });
});

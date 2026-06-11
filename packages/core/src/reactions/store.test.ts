/** Reaction store — add (idempotent), remove, set-reward, list-for-messages. */

import { messages, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleReactionStore } from './store.js';

describe('DrizzleReactionStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let reactions: DrizzleReactionStore;
  let memory: TranscriptMemoryStore;

  /** Append an assistant message and return its id (a reaction target). */
  async function messageId(content = 'here is an answer'): Promise<string> {
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
    reactions = new DrizzleReactionStore(db);
    memory = new TranscriptMemoryStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('adds a user reaction with no reward yet', async () => {
    const msg = await messageId();
    const row = await reactions.add(companionId, msg, 'user', '❤️');
    expect(row.messageId).toBe(msg);
    expect(row.reactor).toBe('user');
    expect(row.emoji).toBe('❤️');
    expect(row.reward).toBeNull();
    expect(row.rewardNote).toBeNull();
  });

  it('is idempotent on (message, reactor, emoji) — a re-tap returns the same row', async () => {
    const msg = await messageId();
    const first = await reactions.add(companionId, msg, 'user', '👍');
    const again = await reactions.add(companionId, msg, 'user', '👍');
    expect(again.id).toBe(first.id);
    const all = await reactions.listForMessages(companionId, [msg]);
    expect(all).toHaveLength(1);
  });

  it('keeps distinct rows for different emoji and different reactors on one message', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '🎉');
    await reactions.add(companionId, msg, 'user', '👀');
    await reactions.add(companionId, msg, 'companion', '🎉');
    const all = await reactions.listForMessages(companionId, [msg]);
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.reactor === 'companion')).toHaveLength(1);
  });

  it('removes a reaction and reports whether a row was deleted', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '😮');
    expect(await reactions.remove(companionId, msg, 'user', '😮')).toBe(true);
    expect(await reactions.remove(companionId, msg, 'user', '😮')).toBe(false);
    expect(await reactions.listForMessages(companionId, [msg])).toHaveLength(0);
  });

  it('a companion reaction never carries a reward', async () => {
    const msg = await messageId();
    const row = await reactions.add(companionId, msg, 'companion', '👀');
    expect(row.reward).toBeNull();
    expect(row.rewardNote).toBeNull();
  });

  it('records the inline read reward on a user reaction only', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '😢');
    await reactions.add(companionId, msg, 'companion', '😢');
    await reactions.setReward(companionId, msg, '😢', 0.8, 'moved, engaged');
    const all = await reactions.listForMessages(companionId, [msg]);
    const userRow = all.find((r) => r.reactor === 'user');
    const companionRow = all.find((r) => r.reactor === 'companion');
    expect(userRow?.reward).toBeCloseTo(0.8);
    expect(userRow?.rewardNote).toBe('moved, engaged');
    expect(companionRow?.reward).toBeNull();
  });

  it('lists reactions across several messages, and returns empty for no ids', async () => {
    const a = await messageId('first');
    const b = await messageId('second');
    await reactions.add(companionId, a, 'user', '❤️');
    await reactions.add(companionId, b, 'user', '👍');
    const both = await reactions.listForMessages(companionId, [a, b]);
    expect(both).toHaveLength(2);
    expect(await reactions.listForMessages(companionId, [])).toHaveLength(0);
  });

  it('removing one reactor leaves the other reactor intact', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '❤️');
    await reactions.add(companionId, msg, 'companion', '❤️');
    expect(await reactions.remove(companionId, msg, 'user', '❤️')).toBe(true);
    const left = await reactions.listForMessages(companionId, [msg]);
    expect(left).toHaveLength(1);
    expect(left[0]?.reactor).toBe('companion');
  });

  it('setReward is a no-op when the reaction was removed meanwhile', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '👍');
    await reactions.remove(companionId, msg, 'user', '👍');
    // Should not throw and should not resurrect the row.
    await reactions.setReward(companionId, msg, '👍', 0.5, 'late read');
    expect(await reactions.listForMessages(companionId, [msg])).toHaveLength(0);
  });

  it('scopes reads and writes by companion (defence in depth)', async () => {
    const identity = new DrizzleIdentityStore(db);
    const otherUser = await identity.ensureUserByEmail('other@example.com');
    const other = await identity.createCompanion(otherUser.id, {
      name: 'Nib',
      form: 'cat',
      temperament: 'aloof',
    });
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '❤️');
    // A different companion sees nothing for this message, and cannot remove it.
    expect(await reactions.listForMessages(other.id, [msg])).toHaveLength(0);
    expect(await reactions.remove(other.id, msg, 'user', '❤️')).toBe(false);
    expect(await reactions.listForMessages(companionId, [msg])).toHaveLength(1);
  });

  it('cascade-deletes reactions when their message is removed', async () => {
    const msg = await messageId();
    await reactions.add(companionId, msg, 'user', '❤️');
    await db.delete(messages).where(eq(messages.id, msg));
    expect(await reactions.listForMessages(companionId, [msg])).toHaveLength(0);
  });
});

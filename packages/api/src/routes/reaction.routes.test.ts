/**
 * User reaction routes (companion-reactions.md §8): auth + ownership guards,
 * persistence, idempotent add/remove, and hydration onto the transcript snapshot.
 * The live `reaction_*` push over the standing channel is covered in `sse.test.ts`
 * (a published event written to the wire); here we assert the persisted state via
 * the transcript's joined `reactions`.
 */

import type { MessageDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('reaction routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;
  let messageId: string;

  /** The transcript's view of one message's reactions (joined on GET). */
  async function reactionsFor(id: string): Promise<readonly string[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    const messages = res.json().messages as MessageDto[];
    const message = messages.find((m) => m.id === id);
    return (message?.reactions ?? []).map((r) => r.emoji);
  }

  beforeEach(async () => {
    ctx = await makeTestApp();
    auth = ctx.bearerFor('owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
    // A companion message to react to (appended directly — avoids driving a turn).
    const message = await ctx.deps.memory.appendMessage(companionId, 'assistant', 'an answer');
    messageId = message.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages/${messageId}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('adds a reaction and hydrates it onto the transcript', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages/${messageId}/reactions`,
      headers: auth,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(200);
    expect(await reactionsFor(messageId)).toEqual(['❤️']);
  });

  it('rejects a missing/empty emoji with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages/${messageId}/reactions`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the message does not belong to the companion', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages/${ABSENT_UUID}/reactions`,
      headers: auth,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a companion the caller doesn't own", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${ABSENT_UUID}/messages/${messageId}/reactions`,
      headers: auth,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s a malformed message id (uuid guard) — not a 500', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages/not-a-uuid/reactions`,
      headers: auth,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('is idempotent — re-adding the same emoji keeps a single reaction', async () => {
    const url = `/companions/${companionId}/messages/${messageId}/reactions`;
    await ctx.app.inject({ method: 'POST', url, headers: auth, payload: { emoji: '👍' } });
    await ctx.app.inject({ method: 'POST', url, headers: auth, payload: { emoji: '👍' } });
    expect(await reactionsFor(messageId)).toEqual(['👍']);
  });

  it('removes a reaction', async () => {
    const url = `/companions/${companionId}/messages/${messageId}/reactions`;
    await ctx.app.inject({ method: 'POST', url, headers: auth, payload: { emoji: '🎉' } });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${url}/${encodeURIComponent('🎉')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(await reactionsFor(messageId)).toEqual([]);
  });

  it('un-reacting something already gone is a clean 200', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/companions/${companionId}/messages/${messageId}/reactions/${encodeURIComponent('😮')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets the companion react to the user message mid-turn, leaving no chrome row', async () => {
    // The model reacts (👀) on its first step, then replies — companion-reactions.md §5.
    const reactCtx = await makeTestApp([
      { toolCalls: [{ name: 'react', args: { emoji: '👀' } }] },
      { chunks: ['On it!'] },
    ]);
    try {
      const a = reactCtx.bearerFor('owner@example.com');
      const created = await reactCtx.app.inject({
        method: 'POST',
        url: '/companions',
        headers: a,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const cid = created.json().companion.id;

      const sent = await reactCtx.app.inject({
        method: 'POST',
        url: `/companions/${cid}/messages`,
        headers: a,
        payload: { content: 'can you check this?' },
      });
      expect(sent.statusCode).toBe(200);

      const res = await reactCtx.app.inject({
        method: 'GET',
        url: `/companions/${cid}/messages`,
        headers: a,
      });
      const messages = res.json().messages as MessageDto[];
      // The companion's 👀 is attached to the user's message…
      const userMsg = messages.find(
        (m) => m.role === 'user' && m.content === 'can you check this?',
      );
      expect(userMsg?.reactions?.some((r) => r.reactor === 'companion' && r.emoji === '👀')).toBe(
        true,
      );
      // …it left NO tool_step chrome row…
      expect(messages.some((m) => m.kind === 'tool_step')).toBe(false);
      // …it created NO proactive outcome (expression awaits no reward, §5)…
      expect(await reactCtx.deps.rewards.list(cid, 10)).toHaveLength(0);
      // …and the reply still streamed.
      expect(messages.some((m) => m.role === 'assistant' && m.content === 'On it!')).toBe(true);
    } finally {
      await reactCtx.close();
    }
  });

  it('triggers learning that resolves the proactive outcome the reaction lands on', async () => {
    // A gateway scripted to report a value-created reward, so the floated read
    // produces a learning signal (the default text gateway would read null).
    const learnCtx = await makeTestApp([
      { toolCalls: [{ name: 'report_reaction', args: { reward: 0.8, note: 'moved' } }] },
    ]);
    try {
      const a = learnCtx.bearerFor('owner@example.com');
      const created = await learnCtx.app.inject({
        method: 'POST',
        url: '/companions',
        headers: a,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const cid = created.json().companion.id;
      const note = await learnCtx.deps.memory.appendMessage(cid, 'assistant', 'I read two things.');
      await learnCtx.deps.rewards.record(cid, { noteMessageId: note.id, drive: 'curiosity' });

      const res = await learnCtx.app.inject({
        method: 'POST',
        url: `/companions/${cid}/messages/${note.id}/reactions`,
        headers: a,
        payload: { emoji: '❤️' },
      });
      expect(res.statusCode).toBe(200);

      // The route floats the read; drain it, then the outcome is resolved by the
      // reaction's value (addressed by note_message_id).
      await learnCtx.deps.reactionLearner.whenIdle();
      const [resolved] = await learnCtx.deps.rewards.list(cid, 1);
      expect(resolved?.reward).toBeCloseTo(0.8);
    } finally {
      await learnCtx.close();
    }
  });
});

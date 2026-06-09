/**
 * Phase 13 Definition-of-Done — User Model: understanding & hygiene, mechanically verified
 * offline (development-plan.md §4c). Drives the real stores + reflector through the app and
 * asserts the mechanical "Done when" criteria (the synthesized-persona-shapes-tone claim is
 * the live `user-persona` judge eval, not a deterministic check):
 *   1. A belief past its half-life FADES from recall — lazy decay drops a stale belief.
 *   2. `deleteFact` REMOVES a fact outright (the explicit forget / sensitive purge), any tier.
 *   3. A low-confidence SENSITIVE inference is REFUSED at write; an explicit one is stored,
 *      flagged, and purgeable.
 *
 * Deterministic: the in-memory store + fake embeddings + scripted reflector turns.
 */

import { FakeEmbeddingGateway, FakeLlmGateway, LlmUserModelReflector } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('Phase 13 DoD — understanding & hygiene', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let userId: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['ok']);
    auth = ctx.bearerFor('owner@example.com');
    const user = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('fades a belief past its half-life out of recall (DoD 1 — lazy decay)', async () => {
    await ctx.deps.userModel.recordBelief({ userId, predicate: 'interestedIn', object: 'jazz' });

    // Now: the belief recalls. ~110 days out (≈3.7 half-lives) a default-salience belief
    // decays below the stale floor and is dropped — forgetting, with no write or delete.
    const now = await ctx.deps.userModel.searchBeliefs(userId, {
      queryEmbedding: [],
      queryText: 'jazz',
      topK: 5,
    });
    expect(now.map((h) => h.belief.object)).toContain('jazz');

    const later = await ctx.deps.userModel.searchBeliefs(userId, {
      queryEmbedding: [],
      queryText: 'jazz',
      topK: 5,
      now: new Date(Date.now() + 110 * 86_400_000),
    });
    expect(later).toHaveLength(0);

    // The belief was not deleted — it still exists, just below the recall floor.
    expect(await ctx.deps.userModel.listCurrentBeliefs(userId)).toHaveLength(1);
  });

  it('deletes a fact outright via the API — the explicit forget / sensitive purge (DoD 2)', async () => {
    // An explicit sensitive identity fact (bornOn → age) is stored AND flagged.
    const born = await ctx.deps.userModel.recordTranscriptFact({
      userId,
      predicate: 'bornOn',
      object: '1990-05-01',
      learnedByCompanionId: companionId,
      confidence: 0.95,
    });
    const before = await ctx.app.inject({ method: 'GET', url: '/user/facts', headers: auth });
    expect(before.json().facts).toMatchObject([{ predicate: 'bornOn', sensitive: true }]);

    // Purge it — a true delete of the row.
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/user/facts/${born.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await ctx.deps.userModel.listCurrent(userId)).toHaveLength(0);
  });

  it('refuses a low-confidence sensitive inference, but stores an explicit one flagged (DoD 3)', async () => {
    // A reflector window; the belief extraction is scripted per case.
    for (let i = 0; i < 6; i++) {
      await ctx.deps.memory.appendMessage(companionId, 'user', `chatting along (${i}).`);
    }
    const embeddings = new FakeEmbeddingGateway();
    const reflector = (gateway: FakeLlmGateway) =>
      new LlmUserModelReflector({
        identity: ctx.deps.identity,
        memory: ctx.deps.memory,
        store: ctx.deps.userModel,
        llm: gateway,
        embeddings,
        model: 'cheap',
        embeddingModel: ctx.deps.config.embeddingModel,
        embeddingDimensions: ctx.deps.config.embeddingDimensions,
        logger: ctx.deps.logger,
      });

    // A low-confidence INFERENCE about a protected matter → gated, never persisted.
    await reflector(
      new FakeLlmGateway([
        {
          toolCalls: [
            {
              name: 'report_user_beliefs',
              args: {
                beliefs: [
                  { attribute: 'believes', value: 'struggles with depression', confidence: 0.4 },
                ],
              },
            },
          ],
        },
        {
          toolCalls: [
            { name: 'report_reconciliation', args: { decisions: [{ index: 0, op: 'add' }] } },
          ],
        },
      ]),
    ).reflect(companionId);
    expect(await ctx.deps.userModel.listCurrentBeliefs(userId)).toHaveLength(0);

    // An EXPLICIT (high-confidence) sensitive belief → stored, flagged, and purgeable.
    for (let i = 0; i < 6; i++) {
      await ctx.deps.memory.appendMessage(
        companionId,
        'user',
        `I am Catholic, just so you know (${i}).`,
      );
    }
    await reflector(
      new FakeLlmGateway([
        {
          toolCalls: [
            {
              name: 'report_user_beliefs',
              args: { beliefs: [{ attribute: 'believes', value: 'is Catholic', confidence: 0.9 }] },
            },
          ],
        },
        {
          toolCalls: [
            { name: 'report_reconciliation', args: { decisions: [{ index: 0, op: 'add' }] } },
          ],
        },
      ]),
    ).reflect(companionId);
    const beliefs = await ctx.deps.userModel.listCurrentBeliefs(userId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({ object: 'is Catholic', sensitive: true });

    // The user can purge it.
    expect(await ctx.deps.userModel.deleteFact(userId, beliefs[0]!.id)).toBe(true);
    expect(await ctx.deps.userModel.listCurrentBeliefs(userId)).toHaveLength(0);
  });
});

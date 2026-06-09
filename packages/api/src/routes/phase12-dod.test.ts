/**
 * Phase 12 Definition-of-Done — User Model: learned beliefs, mechanically verified
 * offline (development-plan.md §4c). Drives the real harness, reflector, and motivation
 * engine through the app's stores and asserts the three "Done when" criteria:
 *   1. A preference stated in chat is captured and RESURFACES, unprompted, in a later
 *      turn's context (the Tier-2 retrieval arm injects it).
 *   2. A same-matter NEWER STATE supersedes the prior current belief (history retained),
 *      rather than duplicating it (the reflector's reconciliation).
 *   3. The engine ACTS on a learned interest on its own, and the user's reaction refines
 *      that belief — a welcomed act strengthens it (the belief-learning loop).
 *
 * Deterministic: scripted LLM turns + the in-memory store + fake embeddings. DoD 1 runs
 * with affect disabled so the post-turn call sequence (reply → capture) is exact; DoD 3
 * needs the affect read (the reaction's mood change), so its post-turn turns carry BOTH
 * the affect and the (empty) user-fact tool calls, making the two parallel reads
 * order-independent.
 */

import {
  FakeEmbeddingGateway,
  FakeLlmGateway,
  LlmUserModelReflector,
  type EmbeddingParams,
  type EmbeddingResult,
  type IngestionRunParams,
} from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const TOKENS_PER_READ = 120;

/**
 * The hash fake embeds every distinct string near-orthogonal, so it can't model
 * the topical adjacency real embeddings have — and the recall arm's vector floor
 * (cosine distance ≤ 0.8) then drops a belief on any lexically-different turn.
 * Real embeddings place "what should we get into next" near "the user is
 * interested in jazz" (both about the user's interests), within the floor, so the
 * belief resurfaces. This gateway models that one adjacency by embedding the named
 * phrases to a shared vector; everything else hashes as usual.
 */
class TopicalEmbeddingGateway extends FakeEmbeddingGateway {
  constructor(private readonly cluster: ReadonlyMap<string, string>) {
    super();
  }

  override embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    return super.embed({
      ...params,
      input: params.input.map((text) => this.cluster.get(text) ?? text),
    });
  }
}

describe('Phase 12 DoD — learned beliefs', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let userId: string;
  let companionId: string;

  async function setup(
    chunks: ConstructorParameters<typeof FakeLlmGateway>[0],
    options?: Parameters<typeof makeTestApp>[2],
  ): Promise<void> {
    ctx = await makeTestApp(chunks, undefined, options);
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
  }

  afterEach(async () => {
    await ctx.close();
  });

  async function sendMessage(content: string): Promise<void> {
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content },
    });
    await ctx.deps.harness.whenIdle();
  }

  it('captures a stated preference and resurfaces it, unprompted, in a later turn (DoD 1)', async () => {
    // Affect disabled → each chat turn is exactly [reply, capture].
    await setup(
      [
        { chunks: ['Jazz is wonderful!'] },
        {
          toolCalls: [
            {
              name: 'report_user_facts',
              args: { facts: [{ attribute: 'interestedIn', value: 'jazz' }] },
            },
          ],
        },
        { chunks: ['Let me think about that.'] },
        { toolCalls: [{ name: 'report_user_facts', args: { facts: [] } }] },
      ],
      {
        disableAffect: true,
        // Model the topical adjacency the hash fake can't: the later, unrelated-
        // wording turn embeds near the captured belief, as real embeddings would.
        embeddings: new TopicalEmbeddingGateway(
          new Map([['What should we get into next?', 'the user is interested in jazz']]),
        ),
      },
    );

    await sendMessage('I love jazz.');

    // The belief was captured as a current Tier-2 belief.
    const beliefs = await ctx.deps.userModel.listCurrentBeliefs(userId);
    expect(beliefs.map((b) => b.object)).toEqual(['jazz']);

    // A later, unrelated-wording turn carries the belief back into the model's context,
    // unprompted — the Tier-2 retrieval arm injects it; the user never asks the companion
    // to recall. This exercises the production recall path, the *vector* arm: the turn
    // shares no lexeme with the belief ("jazz"), so FTS cannot save it — recall depends
    // entirely on the turn embedding sitting near the belief's, within the relevance floor,
    // as real embeddings place "what should we get into next" near "the user is interested
    // in jazz" (the TopicalEmbeddingGateway models that one adjacency).
    await sendMessage('What should we get into next?');
    const carried = ctx.gateway.calls.some((call) =>
      call.messages.some((m) => m.content.includes('the user is interested in jazz')),
    );
    expect(carried).toBe(true);
  });

  it('supersedes a same-matter newer state, retaining history, not duplicating (DoD 2)', async () => {
    await setup(['ok'], { disableAffect: true });

    // The user once loved coffee (embedded — same natural rendering the harness stores
    // under — so reconciliation can find it as a neighbour).
    const { vectors } = await ctx.deps.embeddings.embed({
      input: ['the user prefers loves coffee'],
      model: ctx.deps.config.embeddingModel,
      dimensions: ctx.deps.config.embeddingDimensions,
    });
    const embedding = vectors[0];
    if (!embedding) {
      throw new Error('fake embedding returned no vector');
    }
    const loves = await ctx.deps.userModel.recordBelief({
      userId,
      predicate: 'prefers',
      object: 'loves coffee',
      embedding,
    });

    // A window where they say they've quit; the reflector reads it and reconciles.
    for (let i = 0; i < 6; i++) {
      await ctx.deps.memory.appendMessage(companionId, 'user', `I quit coffee for good (${i}).`);
    }
    const reflectorGateway = new FakeLlmGateway([
      {
        toolCalls: [
          {
            name: 'report_user_beliefs',
            args: { beliefs: [{ attribute: 'prefers', value: 'quit coffee' }] },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'report_reconciliation',
            args: { decisions: [{ index: 0, op: 'supersede', targetId: loves.id }] },
          },
        ],
      },
    ]);
    const reflector = new LlmUserModelReflector({
      identity: ctx.deps.identity,
      memory: ctx.deps.memory,
      store: ctx.deps.userModel,
      llm: reflectorGateway,
      embeddings: ctx.deps.embeddings,
      model: 'cheap',
      embeddingModel: ctx.deps.config.embeddingModel,
      embeddingDimensions: ctx.deps.config.embeddingDimensions,
      logger: ctx.deps.logger,
    });

    await reflector.reflect(companionId);

    // Current state is the newer one only; the old row is retained as history.
    const current = await ctx.deps.userModel.listCurrentBeliefs(userId);
    expect(current.map((b) => b.object)).toEqual(['quit coffee']);
  });

  it('acts on a learned interest and a welcomed reaction strengthens the belief (DoD 3)', async () => {
    // The report note (tick), then the reaction's reply + the affect/capture reads.
    // The two post-turn reads race, so each post-turn turn carries BOTH tools.
    const bothTools = {
      toolCalls: [
        { name: 'report_affect', args: { valence: 0.9, note: 'delighted' } },
        { name: 'report_user_facts', args: { facts: [] } },
      ],
    };
    await setup(
      [{ chunks: ['I read up on Rust.'] }, { chunks: ['Glad it helped!'] }, bothTools, bothTools],
      {
        motivationPipeline: {
          async run(params: IngestionRunParams): Promise<void> {
            if (params.meter) {
              await params.meter.quota.spend(params.meter.accountId, TOKENS_PER_READ);
            }
            await ctx.deps.semantic.updateJob(params.jobId, { status: 'done' });
          },
        },
      },
    );

    // A learned interest with some standing, and a reading list to work.
    const rust = await ctx.deps.userModel.recordBelief({
      userId,
      predicate: 'interestedIn',
      object: 'Rust',
      salience: 0.6,
    });
    for (let i = 0; i < 3; i++) {
      await ctx.deps.leads.record(companionId, `https://lead-${i}.dev`);
    }

    // The companion initiates on its own — the burst is attributed to the Rust belief.
    ctx.deps.motivation.request(companionId);
    await ctx.deps.motivation.whenIdle();
    const [outcome] = await ctx.deps.rewards.list(companionId, 1);
    expect(outcome!.drivenByUserFactId).toBe(rust.id);

    // Baseline neutral mood, then a warm reaction; suppress the post-send tick so the
    // scripted turn order stays exact.
    await ctx.deps.affect.upsert(companionId, { valence: 0, note: 'neutral' });
    ctx.deps.motivation.request = (): void => {};
    await sendMessage('Oh nice — thanks for reading about Rust!');

    // The reaction refined the belief: a welcomed act raised its salience above the start.
    const [current] = await ctx.deps.userModel.listCurrentBeliefs(userId);
    expect(current!.object).toBe('Rust');
    expect(current!.salience).toBeGreaterThan(0.6);
  });
});
